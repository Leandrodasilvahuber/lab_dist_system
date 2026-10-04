import { SFNClient, ListExecutionsCommand, GetExecutionHistoryCommand } from '@aws-sdk/client-sfn';

// Quantidade fixa de compras analisadas: uma GetExecutionHistory por compra
export const RECENT_EXECUTIONS = 10;

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
  constructor({ stateMachineArn = process.env.SAGA_STATE_MACHINE_ARN, client } = {}) {
    this.stateMachineArn = stateMachineArn;
    const endpoint = process.env.STEPFUNCTIONS_ENDPOINT || process.env.AWS_ENDPOINT;
    this.client = client || new SFNClient({
      region: process.env.AWS_REGION || 'us-east-1',
      ...(endpoint && { endpoint })
    });
  }

  async recentMetrics() {
    if (!this.stateMachineArn) {
      throw new Error('SAGA_STATE_MACHINE_ARN is not configured');
    }

    const { executions = [] } = await this.client.send(new ListExecutionsCommand({
      stateMachineArn: this.stateMachineArn,
      maxResults: RECENT_EXECUTIONS
    }));

    const sagas = await Promise.all(executions.map(async execution => ({
      sagaId: execution.name,
      status: execution.status,
      startedAt: iso(execution.startDate),
      durationMs: execution.stopDate ? execution.stopDate - execution.startDate : null,
      steps: stepsFromHistory(await this.history(execution.executionArn))
    })));

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

function summarize(sagas) {
  const finished = sagas.filter(saga => saga.durationMs !== null);
  return {
    total: sagas.length,
    succeeded: sagas.filter(saga => saga.status === 'SUCCEEDED').length,
    failed: sagas.filter(saga => ['FAILED', 'TIMED_OUT', 'ABORTED'].includes(saga.status)).length,
    running: sagas.filter(saga => saga.status === 'RUNNING').length,
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
