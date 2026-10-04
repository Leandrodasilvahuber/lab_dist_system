import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SagaMetricsClient, stepsFromHistory, sagaIdFromExecution, RECENT_EXECUTIONS, METRICS_CACHE_TTL_MS } from '../../../src/layers/api-gateway-layer/src/services/SagaMetricsClient.js';
import { createAPIHandler } from '../../../src/layers/api-gateway-layer/src/routes/apiRoutes.js';
import { isAdminRoute } from '../../../src/common/auth.mjs';

process.env.LOG_LEVEL = 'silent';

const at = seconds => new Date(Date.UTC(2026, 9, 4, 10, 0, 0) + seconds * 1000);

const entered = (name, s) => ({ type: 'TaskStateEntered', timestamp: at(s), stateEnteredEventDetails: { name } });
const exited = (name, s) => ({ type: 'TaskStateExited', timestamp: at(s), stateExitedEventDetails: { name } });
const scheduled = s => ({ type: 'TaskScheduled', timestamp: at(s) });
const succeeded = s => ({ type: 'TaskSucceeded', timestamp: at(s) });
const failed = (s, error) => ({ type: 'TaskFailed', timestamp: at(s), taskFailedEventDetails: { error } });

// Compra que falhou no pagamento (com um retry) e liberou o estoque
const failedHistory = [
  { type: 'ExecutionStarted', timestamp: at(0) },
  entered('CreateOrder', 0), scheduled(0), succeeded(0.1), exited('CreateOrder', 0.1),
  entered('RecordCreateOrder', 0.1), exited('RecordCreateOrder', 0.15),
  entered('ReserveStock', 0.2), scheduled(0.2), succeeded(0.4), exited('ReserveStock', 0.4),
  entered('ProcessPayment', 0.5), scheduled(0.5), failed(1, 'Lambda.Unknown'), scheduled(2), failed(2.5, 'PaymentDeclined'),
  exited('ProcessPayment', 2.5),
  entered('ReleaseStock', 2.6), scheduled(2.6), succeeded(2.7), exited('ReleaseStock', 2.7)
];

function fakeSfn({ executions, histories }) {
  return {
    sent: [],
    async send(command) {
      this.sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'ListExecutionsCommand') return { executions };
      return { events: histories[command.input.executionArn] };
    }
  };
}

describe('stepsFromHistory', () => {
  it('mede cada passo, conta tentativas e ignora os estados Record*', () => {
    const steps = stepsFromHistory(failedHistory);

    assert.deepStrictEqual(steps.map(s => s.name), ['CreateOrder', 'ReserveStock', 'ProcessPayment', 'ReleaseStock']);
    assert.strictEqual(steps[0].durationMs, 100);
    assert.deepStrictEqual(
      { ...steps[2], startedAt: undefined },
      { name: 'ProcessPayment', compensation: false, startedAt: undefined, durationMs: 2000, attempts: 2, ok: false, error: 'PaymentDeclined' }
    );
    assert.strictEqual(steps[3].compensation, true);
    assert.strictEqual(steps[3].ok, true);
  });

  it('passo ainda aberto (execução em andamento) entra sem duração', () => {
    const steps = stepsFromHistory([entered('CreateOrder', 0), scheduled(0)]);
    assert.strictEqual(steps[0].durationMs, null);
    assert.strictEqual(steps[0].ok, null);
  });
});

describe('SagaMetricsClient', () => {
  it(`lê só as ${RECENT_EXECUTIONS} execuções mais recentes e agrega por passo`, async () => {
    const client = fakeSfn({
      executions: [
        { executionArn: 'arn:1', name: 'saga-1', status: 'FAILED', startDate: at(0), stopDate: at(3) },
        { executionArn: 'arn:2', name: 'saga-2', status: 'RUNNING', startDate: at(10) }
      ],
      histories: { 'arn:1': failedHistory, 'arn:2': [entered('CreateOrder', 10), scheduled(10)] }
    });

    const { sagas, summary, steps } = await new SagaMetricsClient({ stateMachineArn: 'arn:sm', client }).recentMetrics();

    assert.deepStrictEqual(client.sent[0].input, { stateMachineArn: 'arn:sm', maxResults: RECENT_EXECUTIONS });
    assert.strictEqual(sagas[0].durationMs, 3000);
    assert.strictEqual(sagas[1].durationMs, null);
    assert.deepStrictEqual(summary, { total: 2, succeeded: 0, failed: 1, running: 1, avgMs: 3000, maxMs: 3000 });

    const createOrder = steps.find(s => s.name === 'CreateOrder');
    assert.deepStrictEqual(createOrder, { name: 'CreateOrder', compensation: false, count: 2, failed: 0, retries: 0, avgMs: 100, maxMs: 100 });
    assert.strictEqual(steps.find(s => s.name === 'ProcessPayment').retries, 1);
    // Ordem do fluxo: passos antes das compensações, sem os que não rodaram
    assert.deepStrictEqual(steps.map(s => s.name), ['CreateOrder', 'ReserveStock', 'ProcessPayment', 'ReleaseStock']);
  });

  it('sem a state machine configurada, falha', async () => {
    await assert.rejects(new SagaMetricsClient({ stateMachineArn: '', client: fakeSfn({}) }).recentMetrics());
  });

  it('reaproveita a leitura por METRICS_CACHE_TTL_MS', async () => {
    let clock = 0;
    const client = fakeSfn({ executions: [], histories: {} });
    const metrics = new SagaMetricsClient({ stateMachineArn: 'arn:sm', client, now: () => clock });

    await Promise.all([metrics.recentMetrics(), metrics.recentMetrics()]);
    clock = METRICS_CACHE_TTL_MS - 1;
    await metrics.recentMetrics();
    assert.strictEqual(client.sent.length, 1);

    clock = METRICS_CACHE_TTL_MS;
    await metrics.recentMetrics();
    assert.strictEqual(client.sent.length, 2);
  });

  it('não guarda falha no cache', async () => {
    let fail = true;
    const client = { async send() { if (fail) throw new Error('Throttling'); return { executions: [] }; } };
    const metrics = new SagaMetricsClient({ stateMachineArn: 'arn:sm', client, now: () => 0 });

    await assert.rejects(metrics.recentMetrics(), /Throttling/);
    fail = false;
    assert.deepStrictEqual((await metrics.recentMetrics()).sagas, []);
  });
});

describe('sagaIdFromExecution', () => {
  const uuidSaga = 'saga_3f2c1a9e-1b2c-4d5e-8f90-123456789012';
  const keySaga = `saga_${'a'.repeat(48)}`;

  it('tira o sufixo de tentativa das sagas reiniciadas', () => {
    assert.strictEqual(sagaIdFromExecution(`${uuidSaga}-2`), uuidSaga);
    assert.strictEqual(sagaIdFromExecution(`${keySaga}-3`), keySaga);
  });

  it('mantém o nome da primeira execução e nomes fora do padrão', () => {
    assert.strictEqual(sagaIdFromExecution(uuidSaga), uuidSaga);
    assert.strictEqual(sagaIdFromExecution(keySaga), keySaga);
    assert.strictEqual(sagaIdFromExecution('saga-1'), 'saga-1');
  });
});

describe('GET /metrics/sagas', () => {
  const event = { requestContext: { http: { method: 'GET' } }, rawPath: '/metrics/sagas', headers: {} };

  it('é rota pública', () => {
    assert.ok(!isAdminRoute('GET', '/metrics/sagas'));
  });

  it('devolve as métricas', async () => {
    const handler = createAPIHandler({ sagaMetrics: { recentMetrics: async () => ({ sagas: [], summary: { total: 0 }, steps: [] }) } });
    const response = await handler(event);
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { sagas: [], summary: { total: 0 }, steps: [] });
  });

  it('erro do Step Functions vira 503', async () => {
    const handler = createAPIHandler({ sagaMetrics: { recentMetrics: async () => { throw new Error('boom'); } } });
    assert.strictEqual((await handler(event)).statusCode, 503);
  });
});
