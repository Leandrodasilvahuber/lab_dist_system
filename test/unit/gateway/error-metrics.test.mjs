import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CloudWatchMetricsClient, METRICS_HOURS, periodFor, parseMetricsQuery, align } from '../../../src/layers/api-gateway-layer/src/services/CloudWatchMetricsClient.js';
import { LogsClient } from '../../../src/layers/api-gateway-layer/src/services/LogsClient.js';
import { createAPIHandler } from '../../../src/layers/api-gateway-layer/src/routes/apiRoutes.js';
import { isAdminRoute } from '../../../src/common/auth.mjs';

process.env.LOG_LEVEL = 'silent';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const minute = n => new Date(NOW - n * 60 * 1000);
const dims = (...pairs) => pairs.map(([Name, Value]) => ({ Name, Value }));

// ListMetrics e GetMetricData com respostas fixas por métrica/consulta
function fakeCloudWatch({ metrics, data }) {
  return {
    sent: [],
    async send(command) {
      this.sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'ListMetricsCommand') {
        return { Metrics: metrics.filter(m => m.MetricName === command.input.MetricName) };
      }
      return {
        MetricDataResults: command.input.MetricDataQueries.map(({ Id }) => ({ Id, Timestamps: data[Id]?.map(([t]) => t) || [], Values: data[Id]?.map(([, v]) => v) || [] }))
      };
    }
  };
}

describe('CloudWatchMetricsClient', () => {
  it('período do gráfico conforme a janela; hours arredondado para um período fixo', () => {
    assert.deepStrictEqual([periodFor(1), periodFor(3), periodFor(24), periodFor(168)], [60, 60, 900, 3600]);
    assert.deepStrictEqual(parseMetricsQuery({}), { hours: 24 });
    assert.deepStrictEqual(parseMetricsQuery({ hours: 'x' }), { hours: 24 });
    assert.deepStrictEqual(parseMetricsQuery({ hours: '99999' }), { hours: 336 });
    assert.deepStrictEqual(parseMetricsQuery({ hours: '1.0001' }), { hours: 1 });
    assert.deepStrictEqual(parseMetricsQuery({ hours: '2.5' }), { hours: 3 });
    assert.deepStrictEqual(parseMetricsQuery({ hours: '12' }), { hours: 3 });
    assert.deepStrictEqual(parseMetricsQuery({ hours: '100' }), { hours: 168 });
  });

  // A rota é pública e o GetMetricData é cobrado por métrica: trocar o hours
  // a cada requisição não pode criar uma leitura nova (chave nova no cache)
  it('qualquer hours cai num dos períodos fixos', () => {
    const seen = new Set();
    for (let h = 0; h <= 400; h++) seen.add(parseMetricsQuery({ hours: String(h) }).hours);
    assert.deepStrictEqual([...seen].sort((a, b) => a - b), METRICS_HOURS);
  });

  it('align põe cada ponto no seu balde e soma pontos do mesmo balde', () => {
    const buckets = [0, 60000, 120000];
    assert.deepStrictEqual(align({ timestamps: [0, 60000, 61000, 999999], values: [1, 2, 3, 4] }, buckets, 60), [1, 5, 0]);
    assert.deepStrictEqual(align(undefined, buckets, 60), [0, 0, 0]);
  });

  it('descobre ErrorType/Action, monta as séries e o resumo por ação', async () => {
    const client = fakeCloudWatch({
      metrics: [
        { MetricName: 'BusinessErrors', Dimensions: [] },
        { MetricName: 'BusinessErrors', Dimensions: dims(['ErrorType', 'PaymentDeclined']) },
        { MetricName: 'BusinessErrors', Dimensions: dims(['ErrorType', 'InsufficientStock']) },
        { MetricName: 'ActionCount', Dimensions: dims(['Action', 'processPayment'], ['Outcome', 'ok']) },
        { MetricName: 'ActionCount', Dimensions: dims(['Action', 'processPayment'], ['Outcome', 'rejected']) }
      ],
      data: {
        business: [[minute(30), 3]],
        business_0: [[minute(30), 1]],
        business_1: [[minute(30), 2]],
        client: [[minute(10), 4], [minute(20), 1]],
        calls_0_ok: [[minute(30), 3]],
        calls_0_rejected: [[minute(30), 1]],
        duration_0_ok: [[minute(30), 300]],
        duration_0_rejected: [[minute(30), 100]],
        max_0_ok: [[minute(30), 250]],
        max_0_rejected: [[minute(30), 100]]
      }
    });
    const result = await new CloudWatchMetricsClient({ namespace: 'Ecommerce/dev', client, now: () => NOW }).errorMetrics({ hours: 1 });

    assert.strictEqual(result.periodSeconds, 60);
    assert.strictEqual(result.buckets.length, 60);
    assert.strictEqual(result.business.total, 3);
    // Mais frequente primeiro; InsufficientStock é business_0 (ordem alfabética do ListMetrics)
    assert.deepStrictEqual(result.business.byType.map(t => [t.errorType, t.total]), [['PaymentDeclined', 2], ['InsufficientStock', 1]]);
    assert.strictEqual(result.unhandled.total, 0);
    assert.deepStrictEqual(result.client, { total: 5 });
    assert.deepStrictEqual(result.unhandled.byType, []);
    const [action] = result.actions;
    assert.deepStrictEqual(
      { action: action.action, calls: action.calls, ok: action.ok, rejected: action.rejected, failed: action.failed, avgMs: action.avgMs, maxMs: action.maxMs },
      { action: 'processPayment', calls: 4, ok: 3, rejected: 1, failed: 0, avgMs: 100, maxMs: 250 }
    );

    const byId = Object.fromEntries(client.sent.filter(c => c.name === 'GetMetricDataCommand')
      .flatMap(c => c.input.MetricDataQueries).map(q => [q.Id, q.MetricStat]));
    assert.deepStrictEqual(byId.business_1.Metric.Dimensions, dims(['ErrorType', 'PaymentDeclined']));
    assert.strictEqual(byId.max_0_ok.Stat, 'Maximum');
    assert.deepStrictEqual(byId.calls_0_failed.Metric.Dimensions, dims(['Action', 'processPayment'], ['Outcome', 'failed']));
    assert.strictEqual(byId.business.Metric.Namespace, 'Ecommerce/dev');
    // Série por minuto para os erros; ações em um ponto só, do tamanho da janela
    assert.strictEqual(byId.business_0.Period, 60);
    assert.strictEqual(byId.calls_0_ok.Period, 3600);
  });

  it('reaproveita a leitura por alguns segundos, por período', async () => {
    const client = fakeCloudWatch({ metrics: [], data: {} });
    let now = NOW;
    const metrics = new CloudWatchMetricsClient({ client, now: () => now });
    await metrics.errorMetrics({ hours: 1 });
    await metrics.errorMetrics({ hours: 1 });
    const reads = () => client.sent.filter(c => c.name === 'GetMetricDataCommand').length;
    assert.strictEqual(reads(), 1);
    await metrics.errorMetrics({ hours: 24 });
    assert.strictEqual(reads(), 2);
    now += 60 * 1000;
    await metrics.errorMetrics({ hours: 1 });
    assert.strictEqual(reads(), 3);
  });
});

describe('GET /metrics/errors', () => {
  const req = query => ({ requestContext: { http: { method: 'GET' } }, rawPath: '/metrics/errors', headers: {}, queryStringParameters: query });

  it('repassa hours e devolve as séries', async () => {
    let received;
    const handler = createAPIHandler({ metrics: { errorMetrics: async q => { received = q; return { business: { total: 0 } }; } } });
    const response = await handler(req({ hours: '3' }));
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(received, { hours: 3 });
  });

  it('CloudWatch indisponível vira 503; rota é pública', async () => {
    const handler = createAPIHandler({ metrics: { errorMetrics: async () => { throw new Error('AccessDenied'); } } });
    assert.strictEqual((await handler(req({}))).statusCode, 503);
    assert.ok(!isAdminRoute('GET', '/metrics/errors'));
  });
});

describe('GET /trace/{correlationId}', () => {
  const req = id => ({ requestContext: { http: { method: 'GET' } }, rawPath: `/trace/${id}`, headers: {} });

  it('LogsClient.trace filtra pelo correlationId e devolve em ordem, sem campos EMF', async () => {
    const client = { sent: [], async send(command) {
      this.sent.push(command.input);
      return { events: [
        { message: `2026-10-04T11:00:02.000Z\treq\tINFO\t${JSON.stringify({ timestamp: '2026-10-04T11:00:02Z', event: 'B', status: 'warn', correlationId: 'saga_1', BusinessErrors: 1, ErrorType: 'X', _aws: { CloudWatchMetrics: [{ Dimensions: [['ErrorType']], Metrics: [{ Name: 'BusinessErrors' }] }] } })}` },
        { message: JSON.stringify({ timestamp: '2026-10-04T11:00:01Z', event: 'A', status: 'info', correlationId: 'saga_1' }) }
      ] };
    } };
    const logs = await new LogsClient({ logGroupName: 'g', client }).trace('saga_1', NOW);

    assert.strictEqual(client.sent[0].filterPattern, '{ $.correlationId = "saga_1" }');
    assert.deepStrictEqual(logs.map(l => l.event), ['A', 'B']);
    assert.strictEqual(logs[1].BusinessErrors, undefined);
  });

  it('id com caracteres fora de [\\w.:-] é 400 (entraria no filter pattern)', async () => {
    let called = false;
    const handler = createAPIHandler({ logs: { trace: async () => { called = true; return []; } } });
    assert.strictEqual((await handler(req('a%22b'))).statusCode, 400);
    assert.strictEqual(called, false);
  });

  it('devolve { correlationId, logs }; erro do CloudWatch vira 503; rota é pública', async () => {
    const ok = createAPIHandler({ logs: { trace: async id => [{ event: 'A', correlationId: id }] } });
    const response = await ok(req('saga_1'));
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { correlationId: 'saga_1', logs: [{ event: 'A', correlationId: 'saga_1' }] });

    const failing = createAPIHandler({ logs: { trace: async () => { throw new Error('AccessDenied'); } } });
    assert.strictEqual((await failing(req('saga_1'))).statusCode, 503);
    assert.ok(!isAdminRoute('GET', '/trace/saga_1'));
  });
});
