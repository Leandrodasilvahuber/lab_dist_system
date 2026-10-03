import { randomUUID } from 'node:crypto';
import { Database } from '../../../../common/database.mjs';
import { ProductSDK } from '../../../../common/sdks/index.mjs';
import { NotFoundError, ValidationError } from '../../../../common/errors.mjs';
import { log } from '../../../../common/logger.mjs';
import { StepFunctionsClient } from './StepFunctionsClient.js';

export const SagaStatus = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  COMPENSATING: 'COMPENSATING',
  COMPENSATED: 'COMPENSATED',
  FAILED: 'FAILED',
  COMPENSATION_FAILED: 'COMPENSATION_FAILED'
};

// Ordem dos passos, para exibir o progresso
export const SAGA_STEPS = ['createOrder', 'processPayment', 'reserveStock', 'confirmOrder'];

/**
 * Inicia e consulta sagas de compra.
 * A execução dos passos e a compensação ficam a cargo do Step Functions
 * (workflow/saga-workflow.asl.json), que também atualiza o registro da saga.
 */
export class SagaService {
  constructor({ db = new Database(), stepFunctions = new StepFunctionsClient(), productSDK } = {}) {
    this.db = db;
    this.stepFunctions = stepFunctions;
    this.productSDK = productSDK || new ProductSDK(null, db);
  }

  /**
   * Cria o registro da saga e inicia a execução assíncrona.
   * Com a mesma idempotencyKey, devolve a saga já existente em vez de criar outra.
   */
  async startSaga({ productId, quantity, correlationId, idempotencyKey }) {
    if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('productId and a positive integer quantity are required');
    }

    const sagaId = idempotencyKey ? `saga_${sanitize(idempotencyKey)}` : `saga_${randomUUID()}`;

    const existing = await this.db.getItem('sagas', { id: sagaId });
    if (existing) {
      return { saga: existing, created: false };
    }

    // Falha rápida para produto inexistente (evita iniciar uma execução inútil)
    await this.productSDK.getProduct(productId);

    const now = new Date().toISOString();
    const ids = {
      orderId: `order_${sagaId}`,
      paymentId: `pay_${sagaId}`,
      reservationId: `res_${sagaId}`
    };
    const saga = {
      id: sagaId,
      status: SagaStatus.RUNNING,
      productId,
      quantity,
      correlationId: correlationId || sagaId,
      ...ids,
      steps: {},
      createdAt: now,
      updatedAt: now
    };

    const created = await this.db.putItemIfNotExists('sagas', saga);
    if (!created) {
      // Requisição concorrente com a mesma idempotencyKey
      return { saga: await this.db.getItem('sagas', { id: sagaId }), created: false };
    }

    try {
      const executionArn = await this.stepFunctions.startExecution(sagaId, {
        sagaId,
        productId,
        quantity,
        correlationId: saga.correlationId,
        ids
      });

      await this.db.updateItem('sagas', { id: sagaId }, 'SET executionArn = :arn', { ':arn': executionArn });
      saga.executionArn = executionArn;
    } catch (error) {
      log({ event: 'SAGA_START_FAILED', correlationId: saga.correlationId, status: 'error', message: `Failed to start saga ${sagaId}`, error });
      await this.db.updateItem(
        'sagas',
        { id: sagaId },
        'SET #status = :status, #error = :error, updatedAt = :now',
        { ':status': SagaStatus.FAILED, ':error': 'StartExecutionFailed', ':now': new Date().toISOString() },
        { expressionAttributeNames: { '#status': 'status', '#error': 'error' } }
      );
      throw error;
    }

    return { saga, created: true };
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

// Nome de execução do Step Functions: até 80 caracteres [A-Za-z0-9-_]
function sanitize(key) {
  return String(key).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 70);
}
