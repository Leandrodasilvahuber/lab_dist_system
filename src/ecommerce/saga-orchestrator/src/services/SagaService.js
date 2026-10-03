import { createHash, randomUUID } from 'node:crypto';
import { Database } from '../../../../common/database.mjs';
import { IdempotencyConflictError, NotFoundError, ValidationError } from '../../../../common/errors.mjs';
import { log } from '../../../../common/logger.mjs';
import { StepFunctionsClient } from './StepFunctionsClient.js';
import { ProductClient } from './ProductClient.js';

export const SagaStatus = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  COMPENSATING: 'COMPENSATING',
  COMPENSATED: 'COMPENSATED',
  FAILED: 'FAILED',
  COMPENSATION_FAILED: 'COMPENSATION_FAILED'
};

// Ordem dos passos, para exibir o progresso
export const SAGA_STEPS = ['createOrder', 'reserveStock', 'processPayment', 'commitReservation', 'confirmOrder'];

// Erro gravado quando o StartExecution falha: a saga pode ser iniciada de novo
const START_FAILED = 'StartExecutionFailed';

/**
 * Inicia e consulta sagas de compra.
 * A execução dos passos e a compensação ficam a cargo do Step Functions
 * (workflow/saga-workflow.asl.json), que também atualiza o registro da saga.
 */
export class SagaService {
  constructor({ db = new Database(), stepFunctions = new StepFunctionsClient(), productClient = new ProductClient() } = {}) {
    this.db = db;
    this.stepFunctions = stepFunctions;
    this.productClient = productClient;
  }

  /**
   * Cria o registro da saga e inicia a execução assíncrona.
   * Com a mesma idempotencyKey e o mesmo pedido, devolve a saga já existente
   * em vez de criar outra; com um pedido diferente, responde 409. Se a saga
   * existente falhou ao iniciar, ela é iniciada de novo.
   */
  async startSaga({ productId, quantity, correlationId, idempotencyKey }) {
    if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('productId and a positive integer quantity are required');
    }

    const sagaId = idempotencyKey ? sagaIdFromKey(idempotencyKey) : `saga_${randomUUID()}`;

    const existing = await this.db.getItem('sagas', { id: sagaId });
    if (existing) {
      return this.resume(existing, { productId, quantity });
    }

    // Consulta síncrona ao serviço de Products: produto inexistente falha aqui
    // (404 imediato) e o preço fica congelado no momento da compra
    const product = await this.productClient.getProduct(productId);
    const unitPrice = Number(product.price);

    const now = new Date().toISOString();
    const saga = {
      id: sagaId,
      status: SagaStatus.RUNNING,
      productId,
      quantity,
      unitPrice,
      correlationId: correlationId || sagaId,
      orderId: `order_${sagaId}`,
      paymentId: `pay_${sagaId}`,
      reservationId: `res_${sagaId}`,
      startAttempts: 1,
      steps: {},
      createdAt: now,
      updatedAt: now
    };

    const created = await this.db.putItemIfNotExists('sagas', saga);
    if (!created) {
      // Requisição concorrente com a mesma idempotencyKey
      return this.resume(await this.db.getItem('sagas', { id: sagaId }), { productId, quantity });
    }

    await this.launch(saga, sagaId);
    return { saga, created: true };
  }

  /**
   * Saga já existente para a idempotencyKey: confere se é o mesmo pedido e,
   * se ela falhou ao iniciar, inicia de novo.
   */
  async resume(existing, { productId, quantity }) {
    if (existing.productId !== productId || existing.quantity !== quantity) {
      throw new IdempotencyConflictError();
    }
    if (existing.status !== SagaStatus.FAILED || existing.error !== START_FAILED) {
      return { saga: existing, created: false };
    }

    let saga;
    try {
      saga = await this.db.updateItem(
        'sagas',
        { id: existing.id },
        'SET #status = :status, updatedAt = :now, startAttempts = if_not_exists(startAttempts, :one) + :one REMOVE #error',
        { ':status': SagaStatus.RUNNING, ':failed': SagaStatus.FAILED, ':startFailed': START_FAILED, ':now': new Date().toISOString(), ':one': 1 },
        {
          conditionExpression: '#status = :failed AND #error = :startFailed',
          expressionAttributeNames: { '#status': 'status', '#error': 'error' },
          returnValues: 'ALL_NEW'
        }
      );
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      // Outra requisição já reiniciou a saga
      return { saga: await this.db.getItem('sagas', { id: existing.id }), created: false };
    }

    // Nome novo: o Step Functions não aceita repetir o nome de uma execução
    await this.launch(saga, `${saga.id}-${saga.startAttempts}`);
    return { saga, created: true };
  }

  /**
   * Inicia a execução no Step Functions. Se falhar, marca a saga como FAILED
   * (com START_FAILED, para permitir nova tentativa) e relança o erro.
   */
  async launch(saga, executionName) {
    try {
      const executionArn = await this.stepFunctions.startExecution(executionName, {
        sagaId: saga.id,
        productId: saga.productId,
        quantity: saga.quantity,
        unitPrice: saga.unitPrice,
        correlationId: saga.correlationId,
        ids: { orderId: saga.orderId, paymentId: saga.paymentId, reservationId: saga.reservationId }
      });

      await this.db.updateItem('sagas', { id: saga.id }, 'SET executionArn = :arn', { ':arn': executionArn });
      saga.executionArn = executionArn;
    } catch (error) {
      log({ event: 'SAGA_START_FAILED', correlationId: saga.correlationId, status: 'error', message: `Failed to start saga ${saga.id}`, error });
      await this.markStartFailed(saga);
      throw error;
    }
  }

  /**
   * Só marca FAILED se a execução não chegou a rodar nenhum passo: se o
   * StartExecution funcionou e só a resposta se perdeu, a execução já está
   * atualizando o registro e não pode ser sobrescrita.
   */
  async markStartFailed(saga) {
    try {
      await this.db.updateItem(
        'sagas',
        { id: saga.id },
        'SET #status = :status, #error = :error, updatedAt = :now',
        { ':status': SagaStatus.FAILED, ':error': START_FAILED, ':running': SagaStatus.RUNNING, ':now': new Date().toISOString(), ':zero': 0 },
        {
          conditionExpression: '#status = :running AND size(steps) = :zero',
          expressionAttributeNames: { '#status': 'status', '#error': 'error' }
        }
      );
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }

  async getSaga(sagaId) {
    const saga = await this.db.getItem('sagas', { id: sagaId });
    if (!saga) {
      throw new NotFoundError('Saga not found');
    }
    return withProgress(saga);
  }

  async listSagas(filters = {}) {
    const sagas = await this.db.scanItems('sagas');
    return sagas
      .filter(saga => !filters.status || saga.status === filters.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(withProgress);
  }
}

function withProgress(saga) {
  const { errorCause, compensationCause, ...rest } = saga;
  const completed = SAGA_STEPS.filter(step => saga.steps?.[step]?.status === 'COMPLETED').length;

  const steps = Object.fromEntries(Object.entries(saga.steps || {}).map(([name, step]) => {
    const { cause, ...stepRest } = step;
    return [name, cause ? { ...stepRest, error: parseLambdaError(cause) } : stepRest];
  }));

  return {
    ...rest,
    steps,
    ...(errorCause && { error: parseLambdaError(errorCause) }),
    ...(compensationCause && { compensationError: parseLambdaError(compensationCause) }),
    progress: { completed, total: SAGA_STEPS.length, order: SAGA_STEPS }
  };
}

/**
 * O Step Functions grava o erro como {"Error": "...", "Cause": "<JSON da Lambda>"}.
 * Extrai o tipo e a mensagem de negócio, sem o stack trace.
 */
export function parseLambdaError(raw) {
  try {
    const outer = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const inner = typeof outer.Cause === 'string' ? JSON.parse(outer.Cause) : null;
    return {
      type: inner?.errorType || outer.Error,
      message: inner?.errorMessage || outer.Cause
    };
  } catch {
    return { type: 'Unknown', message: String(raw) };
  }
}

/**
 * Id da saga derivado da idempotencyKey. O hash evita colisões entre chaves
 * diferentes (ex.: "a.b" e "a_b") e respeita o limite do nome de execução do
 * Step Functions (80 caracteres [A-Za-z0-9-_]).
 */
export function sagaIdFromKey(key) {
  return `saga_${createHash('sha256').update(String(key)).digest('hex').slice(0, 48)}`;
}
