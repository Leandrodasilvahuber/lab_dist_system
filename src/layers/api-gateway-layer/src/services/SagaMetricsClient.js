import { SFNClient, ListExecutionsCommand, GetExecutionHistoryCommand } from '@aws-sdk/client-sfn';
import { awsClientConfig, QUERY_CLIENT_OPTIONS } from '../../../../common/aws-client.mjs';
import { SagaStatus, finalStatus } from '../../../../common/saga-status.mjs';

// Quantidade fixa de compras analisadas: uma GetExecutionHistory por compra
export const RECENT_EXECUTIONS = 10;

// Cada leitura custa 1 ListExecutions + RECENT_EXECUTIONS GetExecutionHistory,
// APIs com limite de taxa baixo no Step Functions. O resultado é reaproveitado
// por este tempo (aba aberta em vários navegadores, recarregamentos seguidos).
export const METRICS_CACHE_TTL_MS = 20 * 1000;

// Estados da saga que chamam Lambdas (os Record*/Mark* só gravam na tabela de sagas)
const STEPS = ['CreateOrder', 'ReserveStock', 'ProcessPayment', 'CommitReservation', 'ConfirmOrder'];
const COMPENSATIONS = ['RefundPayment', 'ReleaseStock', 'CancelOrder', 'CleanupOrder'];
const TRACKED = new Set([...STEPS, ...COMPENSATIONS]);

/**
 * Métricas de desempenho da saga calculadas na hora a partir do histórico de
 * execuções do Step Functions, sem gravar nada: ListExecutions devolve as mais
 * recentes primeiro e GetExecutionHistory traz cada estado com horário de
 * entrada/saída e cada tentativa (retry). As consultas não são cobradas; só
 * as transições de estado da compra.
 */
export class SagaMetricsClient {
  constructor({ stateMachineArn = process.env.SAGA_STATE_MACHINE_ARN, client, cacheTtlMs = METRICS_CACHE_TTL_MS, now = Date.now } = {}) {
    this.stateMachineArn = stateMachineArn;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cached = null;
    this.client = client || new SFNClient(awsClientConfig('STEPFUNCTIONS_ENDPOINT', QUERY_CLIENT_OPTIONS));
  }

  /**
   * Guarda a promessa (não o resultado): chamadas simultâneas dividem a mesma
   * leitura. Uma falha não fica no cache.
   */
  recentMetrics() {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.value;
    const value = this.readMetrics();
    this.cached = { value, expiresAt: this.now() + this.cacheTtlMs };
    value.catch(() => { if (this.cached?.value === value) this.cached = null; });
    return value;
  }

  async readMetrics() {
    if (!this.stateMachineArn) {
      throw new Error('SAGA_STATE_MACHINE_ARN is not configured');
    }

    const { executions = [] } = await this.client.send(new ListExecutionsCommand({
      stateMachineArn: this.stateMachineArn,
      maxResults: RECENT_EXECUTIONS
    }));

    const sagas = await Promise.all(executions.map(async execution => {
      const events = await this.history(execution.executionArn);
      const steps = stepsFromHistory(events);
      return {
        sagaId: sagaIdFromExecution(execution.name),
        status: sagaStatus(execution.status, events, steps),
        startedAt: iso(execution.startDate),
        durationMs: execution.stopDate ? execution.stopDate - execution.startDate : null,
        steps
      };
    }));

    return { sagas, summary: summarize(sagas), steps: aggregateSteps(sagas) };
  }

  async history(executionArn) {
    const events = [];
    let nextToken;
    do {
      const page = await this.client.send(new GetExecutionHistoryCommand({
        executionArn,
        maxResults: 1000,
        includeExecutionData: false,
        nextToken
      }));
      events.push(...(page.events || []));
      nextToken = page.nextToken;
    } while (nextToken);
    return events;
  }
}

/**
 * Uma saga reiniciada (StartExecution falhou antes) roda numa execução de nome
 * `<sagaId>-<tentativa>` (SagaService.resume): devolve só o sagaId, que é o id
 * consultado em GET /saga/{id}. O sagaId é `saga_<uuid>` ou `saga_<48 hex>`;
 * outros nomes voltam como estão.
 */
const EXECUTION_NAME = /^(saga_(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{48}))(?:-\d+)?$/;

export function sagaIdFromExecution(name) {
  return EXECUTION_NAME.exec(name ?? '')?.[1] ?? name;
}

/**
 * Converte o histórico em passos: duração entre TaskStateEntered e
 * TaskStateExited, tentativas = TaskScheduled dentro do estado e o último erro.
 * A saga não tem estados paralelos, então só um estado está aberto por vez.
 */
export function stepsFromHistory(events) {
  const steps = [];
  let open = null;

  for (const event of events) {
    const entered = event.stateEnteredEventDetails?.name;
    const exited = event.stateExitedEventDetails?.name;

    if (event.type === 'TaskStateEntered' && TRACKED.has(entered)) {
      open = { name: entered, enteredAt: event.timestamp, attempts: 0, ok: false, error: null };
    } else if (open && event.type === 'TaskScheduled') {
      open.attempts++;
    } else if (open && event.type === 'TaskSucceeded') {
      open.ok = true;
      open.error = null;
    } else if (open && (event.type === 'TaskFailed' || event.type === 'TaskTimedOut')) {
      const details = event.taskFailedEventDetails || event.taskTimedOutEventDetails || {};
      open.ok = false;
      open.error = details.error || event.type;
    } else if (open && event.type === 'TaskStateExited' && exited === open.name) {
      steps.push(toStep(open, event.timestamp));
      open = null;
    }
  }

  // Execução em andamento: o estado aberto entra sem duração
  if (open) steps.push(toStep(open, null));
  return steps;
}

function toStep({ name, enteredAt, attempts, ok, error }, exitedAt) {
  return {
    name,
    compensation: COMPENSATIONS.includes(name),
    startedAt: iso(enteredAt),
    durationMs: exitedAt ? exitedAt - enteredAt : null,
    attempts,
    ok: exitedAt ? ok : null,
    error
  };
}

/**
 * Status da saga (os mesmos nomes de GET /saga/{id}) a partir da execução: o
 * Step Functions marca FAILED também a compra compensada, e só o Error do
 * evento ExecutionFailed (SagaCompensated, SagaFailed...) separa as duas.
 * Em andamento, COMPENSATING se alguma compensação já começou.
 */
export function sagaStatus(executionStatus, events, steps) {
  if (executionStatus === 'RUNNING') {
    return steps.some(step => step.compensation) ? SagaStatus.COMPENSATING : SagaStatus.RUNNING;
  }
  const failed = events.findLast(event => event.type === 'ExecutionFailed');
  return finalStatus({ status: executionStatus, error: failed?.executionFailedEventDetails?.error })?.status ?? executionStatus;
}

const count = (sagas, ...statuses) => sagas.filter(saga => statuses.includes(saga.status)).length;

function summarize(sagas) {
  const finished = sagas.filter(saga => saga.durationMs !== null);
  return {
    total: sagas.length,
    completed: count(sagas, SagaStatus.COMPLETED),
    // Desfeita de propósito (pagamento recusado, sem estoque): resultado esperado
    compensated: count(sagas, SagaStatus.COMPENSATED),
    failed: count(sagas, SagaStatus.FAILED, SagaStatus.COMPENSATION_FAILED),
    running: count(sagas, SagaStatus.RUNNING, SagaStatus.COMPENSATING),
    avgMs: average(finished.map(saga => saga.durationMs)),
    maxMs: max(finished.map(saga => saga.durationMs))
  };
}

// Por passo, na ordem do fluxo (passos e depois compensações); só os que aparecem
function aggregateSteps(sagas) {
  const all = sagas.flatMap(saga => saga.steps);
  return [...STEPS, ...COMPENSATIONS]
    .map(name => {
      const runs = all.filter(step => step.name === name);
      const durations = runs.map(step => step.durationMs).filter(ms => ms !== null);
      return {
        name,
        compensation: COMPENSATIONS.includes(name),
        count: runs.length,
        failed: runs.filter(step => step.ok === false).length,
        retries: runs.reduce((sum, step) => sum + Math.max(step.attempts - 1, 0), 0),
        avgMs: average(durations),
        maxMs: max(durations)
      };
    })
    .filter(step => step.count > 0);
}

function average(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function max(values) {
  return values.length ? Math.max(...values) : null;
}

function iso(date) {
  return date ? new Date(date).toISOString() : null;
}
