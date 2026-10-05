import { createHash } from 'node:crypto';
import { Database } from '../../../../common/database.mjs';
import { DependencyUnavailableError, IdempotencyConflictError, NotFoundError, ValidationError } from '../../../../common/errors.mjs';
import { log } from '../../../../common/logger.mjs';
import { encodeToken } from '../../../../common/pagination.mjs';
import { SAGAS_BY_DAY_INDEX, dayShardsInWindow, sagaDayShard } from '../../../../common/saga-day-index.mjs';
import { STUCK_AFTER_MS } from '../../../../common/saga-timing.mjs';
import { StepFunctionsClient } from './StepFunctionsClient.js';
import { ProductClient } from '../../../../common/product-client.mjs';

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

// Reconciliação: a execução terminou mas a gravação do status final falhou
// (o Catch das gravações deixa o fluxo seguir) ou a execução estourou o teto
// (TimeoutSeconds, encerrada sem compensar). Status final pelo Error do estado
// Fail do workflow; o resto exige intervenção manual
const IN_PROGRESS = [SagaStatus.RUNNING, SagaStatus.COMPENSATING];
const STATUS_BY_EXECUTION_ERROR = {
  SagaCompensated: SagaStatus.COMPENSATED,
  SagaFailed: SagaStatus.FAILED,
  CompensationFailed: SagaStatus.COMPENSATION_FAILED
};
// A varredura (reconcileStuckSagas) olha as sagas criadas neste período e
// corrige até RECONCILE_MAX por rodada (cabe no Timeout da Lambda; o resto
// fica para a próxima)
export const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RECONCILE_MAX = 50;

// A saga é relida logo depois de gravada (idempotência, corrida entre requisições
// com a mesma chave, GET /saga/{id} logo após o 202): leitura consistente
const CONSISTENT = { consistentRead: true };

/**
 * Inicia e consulta sagas de compra.
 * A execução dos passos e a compensação ficam a cargo do Step Functions
 * (workflow/saga-workflow.asl.json), que também atualiza o registro da saga.
 */
export class SagaService {
  constructor({ db = new Database(), stepFunctions = new StepFunctionsClient(), productClient = new ProductClient(), now = Date.now } = {}) {
    this.db = db;
    this.stepFunctions = stepFunctions;
    this.productClient = productClient;
    this.now = now;
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
      updatedAt: now,
      // Chave do SagasByDayIndex (aba SLOs)
      dayShard: sagaDayShard(sagaId, now)
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
    const restart = restartCondition(existing, this.now());
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
    return withProgress(await this.reconcile(saga));
  }

  /**
   * Saga em andamento parada há mais de STUCK_AFTER_MS: pergunta ao Step
   * Functions como a execução terminou e grava o status final. Execução ainda
   * rodando não é mexida (o teto da execução resolve). Sem resposta do Step
   * Functions, devolve a saga como está: a consulta não pode falhar por isso.
   *
   * Sem executionArn gravado, a execução é procurada pelo nome: ou ela rodou e
   * só a gravação do ARN falhou (SAGA_ARN_NOT_RECORDED), ou nunca existiu (a
   * Lambda morreu antes do StartExecution). No segundo caso a saga vira
   * FAILED/START_FAILED: a mesma Idempotency-Key a inicia de novo, e ela deixa
   * de contar como parada no alarme sagas-stuck.
   */
  async reconcile(saga) {
    if (!IN_PROGRESS.includes(saga.status)) return saga;
    if (this.now() - Date.parse(saga.updatedAt) <= STUCK_AFTER_MS) return saga;

    let execution;
    try {
      const executionArn = saga.executionArn || this.stepFunctions.executionArn(saga.executionName || saga.id);
      execution = await this.stepFunctions.describeExecution(executionArn);
    } catch (error) {
      if (error.name === 'ExecutionDoesNotExist' && !saga.executionArn) return this.markNeverStarted(saga);
      log({ event: 'SAGA_RECONCILE_SKIPPED', correlationId: saga.correlationId, status: 'info', message: `Could not check execution of saga ${saga.id}: ${error.message}` });
      return saga;
    }
    const final = finalStatus(execution);
    if (!final) return saga;
    const { status: from, updatedAt: seenAt } = saga;

    let updated;
    try {
      updated = await this.db.updateItem(
        'sagas',
        { id: saga.id },
        `SET #status = :status, updatedAt = :now, reconciledFrom = :execution${final.error ? ', compensationError = :error' : ''}`,
        {
          ':status': final.status,
          ':now': new Date(this.now()).toISOString(),
          ':execution': execution.status,
          ':expectedStatus': from,
          ':expectedAt': seenAt,
          ...(final.error && { ':error': final.error })
        },
        {
          // Só se ninguém mexeu nela desde a leitura (o próprio workflow, outra varredura)
          conditionExpression: '#status = :expectedStatus AND updatedAt = :expectedAt',
          expressionAttributeNames: { '#status': 'status' },
          returnValues: 'ALL_NEW'
        }
      );
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      return (await this.db.getItem('sagas', { id: saga.id }, CONSISTENT)) || saga;
    }
    // error: o status final não foi gravado pelo workflow (ou a execução
    // estourou o teto). Entra no alarme de erros não tratados
    const message = `Saga ${saga.id} was ${from} but its execution ended as ${execution.status}${execution.error ? ` (${execution.error})` : ''}: marked ${final.status}`;
    log({
      event: 'SAGA_RECONCILED',
      correlationId: saga.correlationId,
      status: 'error',
      message,
      data: { sagaId: saga.id, from, to: final.status, execution: execution.status },
      // Sem stack: o tipo basta para o ErrorType da métrica UnhandledErrors
      error: { name: 'SagaReconciled', message }
    });
    return updated;
  }

  /**
   * A execução da saga nunca existiu: marca START_FAILED (restartCondition
   * permite reiniciar), só se ninguém mexeu nela desde a leitura
   */
  async markNeverStarted(saga) {
    let updated;
    try {
      updated = await this.db.updateItem(
        'sagas',
        { id: saga.id },
        'SET #status = :status, #error = :error, updatedAt = :now',
        {
          ':status': SagaStatus.FAILED,
          ':error': START_FAILED,
          ':now': new Date(this.now()).toISOString(),
          ':running': SagaStatus.RUNNING,
          ':zero': 0,
          ':seen': saga.updatedAt
        },
        {
          conditionExpression: '#status = :running AND attribute_not_exists(executionArn) AND size(steps) = :zero AND updatedAt = :seen',
          expressionAttributeNames: { '#status': 'status', '#error': 'error' },
          returnValues: 'ALL_NEW'
        }
      );
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      return (await this.db.getItem('sagas', { id: saga.id }, CONSISTENT)) || saga;
    }
    // error: a Lambda morreu (timeout, OOM) entre gravar a saga e iniciá-la
    const message = `Saga ${saga.id} was never started: marked ${SagaStatus.FAILED} (${START_FAILED}), the same Idempotency-Key starts it again`;
    log({
      event: 'SAGA_NEVER_STARTED',
      correlationId: saga.correlationId,
      status: 'error',
      message,
      data: { sagaId: saga.id, from: saga.status, to: SagaStatus.FAILED },
      error: { name: 'SagaNeverStarted', message }
    });
    return updated;
  }

  /**
   * Varredura periódica (agendada no template.yaml; no local-server, a cada
   * minuto): reconcilia as sagas do último dia paradas em andamento. O índice
   * por dia projeta status e updatedAt; só as paradas são lidas por inteiro.
   */
  async reconcileStuckSagas() {
    const now = this.now();
    const since = new Date(now - RECONCILE_WINDOW_MS).toISOString();
    const pages = await Promise.all(dayShardsInWindow(now - RECONCILE_WINDOW_MS, now).map(dayShard =>
      this.db.queryItems('sagas', {
        IndexName: SAGAS_BY_DAY_INDEX,
        KeyConditionExpression: 'dayShard = :dayShard AND createdAt >= :since',
        ExpressionAttributeValues: { ':dayShard': dayShard, ':since': since }
      })
    ));
    const stuck = pages.flat().filter(saga =>
      IN_PROGRESS.includes(saga.status) && now - Date.parse(saga.updatedAt) > STUCK_AFTER_MS);

    let reconciled = 0;
    for (const { id } of stuck.slice(0, RECONCILE_MAX)) {
      // Uma saga que falha (DynamoDB fora do ar) não interrompe a rodada: a
      // métrica abaixo precisa sair sempre
      try {
        const saga = await this.db.getItem('sagas', { id }, CONSISTENT);
        if (!saga) continue;
        const before = saga.status;
        const result = await this.reconcile(saga);
        if (result.status !== before) reconciled++;
      } catch (error) {
        log({ event: 'SAGA_RECONCILE_FAILED', status: 'error', message: `Could not reconcile saga ${id}`, data: { sagaId: id }, error });
      }
    }
    // Paradas que continuaram em andamento (Step Functions sem resposta,
    // execução ainda rodando, falha ao corrigir, além do limite da rodada).
    // Publicada toda rodada, inclusive 0: sem dado, o alarme sagas-stuck fica
    // em "Sem dados" (a varredura parou de rodar)
    const remaining = stuck.length - reconciled;
    log({
      event: 'SAGAS_STUCK_CHECKED',
      // info: saga parada não é erro de negócio; quem avisa é o alarme sagas-stuck
      status: 'info',
      message: `${stuck.length} saga(s) parada(s) em andamento, ${reconciled} corrigida(s), ${remaining} ainda parada(s)`,
      data: { checked: stuck.length, reconciled, stuck: remaining },
      metrics: { metrics: { SagasStuck: { value: remaining } } }
    });
    return { checked: stuck.length, reconciled, stuck: remaining };
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

/**
 * Status final de uma execução encerrada, ou null se ainda está rodando.
 * TIMED_OUT/ABORTED encerram sem compensar: intervenção manual.
 */
export function finalStatus({ status, error }) {
  if (status === 'RUNNING' || !status) return null;
  if (status === 'SUCCEEDED') return { status: SagaStatus.COMPLETED };
  if (status === 'FAILED' && STATUS_BY_EXECUTION_ERROR[error]) return { status: STATUS_BY_EXECUTION_ERROR[error] };
  return { status: SagaStatus.COMPENSATION_FAILED, error: `Execution${status === 'FAILED' ? `Failed:${error || 'unknown'}` : status}` };
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
