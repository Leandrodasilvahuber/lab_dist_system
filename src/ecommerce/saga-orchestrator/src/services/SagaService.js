import { createHash } from 'node:crypto';
import { Database } from '../../../../common/database.mjs';
import { DependencyUnavailableError, IdempotencyConflictError, NotFoundError, ValidationError } from '../../../../common/errors.mjs';
import { log } from '../../../../common/logger.mjs';
import { encodeToken } from '../../../../common/pagination.mjs';
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

// Saga RUNNING sem executionArn e sem passos há mais que isto não chegou a
// iniciar: a Lambda morreu (timeout, OOM) entre gravar o registro e o
// StartExecution, sem marcá-la START_FAILED. Bem acima do Timeout da
// SagaOrchestratorFunction (template.yaml), para não disputar com quem ainda
// está iniciando
export const STUCK_START_MS = 60 * 1000;

// A saga é relida logo depois de gravada (idempotência, corrida entre requisições
// com a mesma chave, GET /saga/{id} logo após o 202): leitura consistente
const CONSISTENT = { consistentRead: true };

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
    // O controller já responde 400 sem o header; aqui garante o contrato
    if (!idempotencyKey) {
      throw new ValidationError('idempotencyKey is required');
    }

    const sagaId = sagaIdFromKey(idempotencyKey);

    const existing = await this.db.getItem('sagas', { id: sagaId }, CONSISTENT);
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
      executionName: sagaId,
      steps: {},
      createdAt: now,
      updatedAt: now
    };

    const created = await this.db.putItemIfNotExists('sagas', saga);
    if (!created) {
      // Requisição concorrente com a mesma idempotencyKey
      return this.resume(await this.db.getItem('sagas', { id: sagaId }, CONSISTENT), { productId, quantity });
    }

    await this.launch(saga);
    return { saga, created: true };
  }

  /**
   * Saga já existente para a idempotencyKey: confere se é o mesmo pedido e,
   * se ela falhou ao iniciar (ou ficou presa antes de iniciar), inicia de novo.
   */
  async resume(existing, { productId, quantity }) {
    if (existing.productId !== productId || existing.quantity !== quantity) {
      throw new IdempotencyConflictError();
    }
    const restart = restartCondition(existing, Date.now());
    if (!restart) {
      return { saga: existing, created: false };
    }

    let saga;
    try {
      saga = await this.db.updateItem(
        'sagas',
        { id: existing.id },
        'SET #status = :status, updatedAt = :now, startAttempts = if_not_exists(startAttempts, :one) + :one REMOVE #error',
        { ':status': SagaStatus.RUNNING, ':now': new Date().toISOString(), ':one': 1, ...restart.values },
        {
          conditionExpression: restart.expression,
          expressionAttributeNames: { '#status': 'status', '#error': 'error' },
          returnValues: 'ALL_NEW'
        }
      );
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      // Outra requisição já reiniciou a saga
      return { saga: await this.db.getItem('sagas', { id: existing.id }, CONSISTENT), created: false };
    }

    if (restart.stuck) {
      log({ event: 'SAGA_START_RECOVERED', correlationId: saga.correlationId, status: 'info', message: `Saga ${saga.id} was never started, starting it again` });
    }
    await this.launch(saga, { retry: true });
    return { saga, created: true };
  }

  /**
   * Inicia a execução no Step Functions. Se falhar, marca a saga como FAILED
   * (com START_FAILED, para permitir nova tentativa) e responde 503.
   * Depois que a execução começou, uma falha ao gravar o executionArn só é
   * registrada no log: a saga está rodando e não pode ser dada como falha.
   */
  async launch(saga, { retry = false } = {}) {
    let executionArn;
    try {
      executionArn = await this.startExecution(saga, retry);
    } catch (error) {
      // Outra requisição assumiu o início: não marca a saga como falha
      if (error instanceof StartSupersededError) throw error;
      log({ event: 'SAGA_START_FAILED', correlationId: saga.correlationId, status: 'error', message: `Failed to start saga ${saga.id}`, error });
      try {
        await this.markStartFailed(saga);
      } catch (markError) {
        // Comum na mesma queda (DynamoDB fora do ar): a saga fica RUNNING sem
        // execução e a mesma Idempotency-Key a reinicia depois de
        // STUCK_START_MS. A resposta continua sendo o 503 da falha original
        log({ event: 'SAGA_START_FAILED_NOT_RECORDED', correlationId: saga.correlationId, status: 'error', message: `Saga ${saga.id} could not be marked as failed to start`, error: markError });
      }
      // A saga ficou marcada para reinício: a mesma Idempotency-Key a inicia de
      // novo. Já registrado acima (SAGA_START_FAILED, com o correlationId)
      throw new DependencyUnavailableError('Could not start the purchase, retry with the same Idempotency-Key', {
        cause: error,
        logged: true
      });
    }

    saga.executionArn = executionArn;
    try {
      await this.db.updateItem('sagas', { id: saga.id }, 'SET executionArn = :arn', { ':arn': executionArn });
    } catch (error) {
      log({ event: 'SAGA_ARN_NOT_RECORDED', correlationId: saga.correlationId, status: 'error', message: `Saga ${saga.id} started but executionArn was not recorded`, error });
    }
  }

  /**
   * Na nova tentativa, repete primeiro o nome e o input da anterior: se aquele
   * StartExecution criou a execução e só a resposta se perdeu (timeout do
   * cliente), o Step Functions (STANDARD) devolve a mesma execução em vez de
   * criar uma segunda compra em paralelo. ExecutionAlreadyExists: a execução
   * anterior já terminou sem registrar passos, e só então vai um nome novo,
   * gravado antes de iniciar para que a tentativa seguinte o repita.
   */
  async startExecution(saga, retry) {
    const input = {
      sagaId: saga.id,
      productId: saga.productId,
      quantity: saga.quantity,
      unitPrice: saga.unitPrice,
      correlationId: saga.correlationId,
      ids: { orderId: saga.orderId, paymentId: saga.paymentId, reservationId: saga.reservationId }
    };
    const name = saga.executionName || legacyExecutionName(saga);
    try {
      return await this.stepFunctions.startExecution(name, input);
    } catch (error) {
      if (!retry || error.name !== 'ExecutionAlreadyExists') throw error;
    }

    const executionName = `${saga.id}-${saga.startAttempts}`;
    try {
      // Só esta tentativa grava o nome: o reinício condicional do resume já
      // garante uma por vez, e a condição deixa isso explícito aqui
      await this.db.updateItem('sagas', { id: saga.id }, 'SET executionName = :name', { ':name': executionName, ':attempt': saga.startAttempts }, {
        conditionExpression: 'startAttempts = :attempt'
      });
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') throw new StartSupersededError();
      throw error;
    }
    saga.executionName = executionName;
    return this.stepFunctions.startExecution(executionName, input);
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
    const saga = await this.db.getItem('sagas', { id: sagaId }, CONSISTENT);
    if (!saga) {
      throw new NotFoundError('Saga not found');
    }
    return withProgress(saga);
  }

  /**
   * Lista as sagas, uma página por vez (`limit`, `startKey`). O Scan não tem
   * ordem: a página vem ordenada (mais recentes primeiro), mas a ordem global
   * fica a cargo de quem junta as páginas.
   */
  async listSagas(filters = {}, { limit, startKey } = {}) {
    const { items, lastKey } = await this.db.scanPage('sagas', { limit, startKey });
    const sagas = items
      .filter(saga => !filters.status || saga.status === filters.status)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .map(withProgress);
    return { sagas, nextToken: encodeToken(lastKey) };
  }
}

/**
 * Outra requisição com a mesma Idempotency-Key reiniciou a saga enquanto esta
 * tentava: 503, e o cliente repete para ler o resultado daquela.
 */
class StartSupersededError extends DependencyUnavailableError {
  constructor() {
    super('Purchase is being started by another request, retry with the same Idempotency-Key', { retryAfterSeconds: 1 });
  }
}

/**
 * Condição para reiniciar uma saga existente, ou null se ela não deve ser
 * reiniciada. Dois casos, ambos sem passos registrados: o StartExecution
 * falhou (START_FAILED) ou a Lambda
 * morreu antes de iniciar (RUNNING sem execução nem passos há STUCK_START_MS).
 * A condição no DynamoDB garante que só uma requisição reinicia: o
 * `updatedAt` lido é o que precisa estar lá.
 */
function restartCondition(saga, now) {
  const noSteps = Object.keys(saga.steps || {}).length === 0;
  // Sem passos também no START_FAILED: uma execução que rodou sem conseguir
  // registrar o status (o Catch das gravações deixa seguir) não é repetida
  if (saga.status === SagaStatus.FAILED && saga.error === START_FAILED && noSteps) {
    return {
      expression: '#status = :failed AND #error = :startFailed AND size(steps) = :zero',
      values: { ':failed': SagaStatus.FAILED, ':startFailed': START_FAILED, ':zero': 0 }
    };
  }
  const stuck = saga.status === SagaStatus.RUNNING && !saga.executionArn && noSteps &&
    now - Date.parse(saga.updatedAt) > STUCK_START_MS;
  if (stuck) {
    return {
      stuck: true,
      expression: '#status = :running AND attribute_not_exists(executionArn) AND size(steps) = :zero AND updatedAt = :seen',
      values: { ':running': SagaStatus.RUNNING, ':zero': 0, ':seen': saga.updatedAt }
    };
  }
  return null;
}

/**
 * Nome da tentativa anterior de uma saga gravada antes do executionName: a 1ª
 * usou o id e as seguintes `<id>-<tentativa>`. Quem chama já incrementou
 * startAttempts para a tentativa atual.
 */
function legacyExecutionName(saga) {
  const previous = (saga.startAttempts || 1) - 1;
  return previous <= 1 ? saga.id : `${saga.id}-${previous}`;
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
