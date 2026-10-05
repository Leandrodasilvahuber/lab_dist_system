import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryMetricsClient, memoryLimitFor } from '../../../src/layers/api-gateway-layer/src/services/MemoryMetricsClient.js';
import { CostClient, parseCostQuery, PRICES, SERVICES, TRANSITIONS_PER_SAGA } from '../../../src/layers/api-gateway-layer/src/services/CostClient.js';
import { createAPIHandler } from '../../../src/layers/api-gateway-layer/src/routes/apiRoutes.js';
import { isAdminRoute } from '../../../src/common/auth.mjs';

process.env.LOG_LEVEL = 'silent';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const TODAY = Date.parse('2026-10-04T00:00:00Z');
const minute = n => new Date(NOW - n * 60 * 1000);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

// ListMetrics por métrica e GetMetricData com respostas fixas por Id
function fakeCloudWatch({ functions = [], data = {} }) {
  return {
    sent: [],
    async send(command) {
      this.sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'ListMetricsCommand') {
        return command.input.MetricName === 'MemoryUsedMB'
          ? { Metrics: functions.map(Value => ({ MetricName: 'MemoryUsedMB', Dimensions: [{ Name: 'FunctionName', Value }] })) }
          : { Metrics: [] };
      }
      return {
        MetricDataResults: command.input.MetricDataQueries.map(({ Id }) => ({
          Id, Timestamps: data[Id]?.map(([t]) => t) || [], Values: data[Id]?.map(([, v]) => v) || []
        }))
      };
    }
  };
}

describe('MemoryMetricsClient', () => {
  it('máximo por balde com lacuna (null) onde não houve invocação, pico e limite', async () => {
    const client = fakeCloudWatch({
      // Nomes vêm ordenados do ListMetrics: max_<índice na ordem alfabética>
      functions: ['dev-OrderFunction', 'dev-ZIdle', 'local-server'],
      data: { max_0: [[minute(30), 90], [minute(10), 120.04]], avg_0: [[minute(30), 80]], max_2: [[minute(5), 300]] }
    });
    const memory = new MemoryMetricsClient({ client, now: () => NOW, env: { FUNCTION_MEMORY_MB: '256' } });
    const result = await memory.memoryMetrics({ hours: 1 });

    assert.strictEqual(result.periodSeconds, 60);
    assert.strictEqual(result.buckets.length, 60);
    // dev-ZIdle sem dado na janela fica de fora
    assert.deepStrictEqual(result.functions.map(f => [f.name, f.peak, f.limitMb]), [['dev-OrderFunction', 120, 256], ['local-server', 300, null]]);
    const order = result.functions[0];
    assert.strictEqual(order.max.filter(v => v !== null).length, 2);
    assert.strictEqual(order.max[0], null);
    assert.strictEqual(order.avg.filter(v => v !== null)[0], 80);
  });

  it('mais de um ponto no balde: máximo dos máximos e média das médias', async () => {
    const t = minute(30);
    const client = fakeCloudWatch({ functions: ['fn'], data: { max_0: [[t, 90], [t, 110]], avg_0: [[t, 60], [t, 80]] } });
    const result = await new MemoryMetricsClient({ client, now: () => NOW }).memoryMetrics({ hours: 1 });
    const index = result.functions[0].max.findIndex(v => v !== null);
    assert.strictEqual(result.functions[0].max[index], 110);
    assert.strictEqual(result.functions[0].avg[index], 70);
  });

  it('limite: MemorySize do template; o local-server não tem', () => {
    assert.strictEqual(memoryLimitFor('local-OrderFunction', { FUNCTION_MEMORY_MB: '512' }), 512);
    assert.strictEqual(memoryLimitFor('x', {}), 256);
    assert.strictEqual(memoryLimitFor('local-server', {}), null);
  });

  it('cache por janela: a 2ª leitura não chama o CloudWatch', async () => {
    const client = fakeCloudWatch({ functions: [] });
    const memory = new MemoryMetricsClient({ client, now: () => NOW });
    await memory.memoryMetrics({ hours: 3 });
    const calls = client.sent.length;
    await memory.memoryMetrics({ hours: 3 });
    assert.strictEqual(client.sent.length, calls);
  });
});

// Cost Explorer: uma página por dia/serviço e a previsão do resto do mês
function fakeCostExplorer({ days = {}, forecast = 1.5, fail = false } = {}) {
  return {
    sent: [],
    async send(command) {
      this.sent.push({ name: command.constructor.name, input: command.input });
      if (fail) throw new Error('AccessDenied');
      if (command.constructor.name === 'GetCostForecastCommand') return { Total: { Amount: String(forecast) } };
      return {
        ResultsByTime: Object.entries(days).map(([Start, groups]) => ({
          TimePeriod: { Start },
          Groups: Object.entries(groups).map(([service, Amount]) => ({ Keys: [service], Metrics: { UnblendedCost: { Amount: String(Amount) } } }))
        }))
      };
    }
  };
}

describe('CostClient', () => {
  it('days entre 1 e 90, padrão 14', () => {
    assert.deepStrictEqual(parseCostQuery({}), { days: 14 });
    assert.deepStrictEqual(parseCostQuery({ days: '500' }), { days: 90 });
    assert.deepStrictEqual(parseCostQuery({ days: '7' }), { days: 7 });
    // Rota pública: o days é a chave do cache, então só os períodos da aba
    assert.deepStrictEqual(parseCostQuery({ days: '10' }), { days: 7 });
    assert.deepStrictEqual(parseCostQuery({ days: '45' }), { days: 30 });
    const seen = new Set();
    for (let d = 0; d <= 200; d++) seen.add(parseCostQuery({ days: String(d) }).days);
    assert.deepStrictEqual([...seen].sort((a, b) => a - b), [7, 14, 30, 90]);
  });

  it('AWS: estimativa por serviço e dia a partir das métricas dos serviços', async () => {
    const cloudwatch = fakeCloudWatch({
      functions: ['dev-OrderFunction'],
      data: {
        lambda_ms_0: [[new Date(TODAY), 1_000_000]],
        lambda_n_0: [[new Date(TODAY), 1000]],
        sfn: [[new Date(TODAY - DAY), 100]],
        api: [[new Date(TODAY), 2000]],
        ddb_r_0: [[new Date(TODAY), 4000]],
        ddb_w_0: [[new Date(TODAY), 1000]]
      }
    });
    const cost = new CostClient({
      cloudwatch,
      costExplorer: fakeCostExplorer(),
      local: false,
      now: () => NOW,
      env: { FUNCTION_MEMORY_MB: '512', SAGA_STATE_MACHINE_ARN: 'arn:sm', ENVIRONMENT: 'dev', ORDERS_TABLE: 'orders', MONTHLY_BUDGET_USD: '5' }
    });
    const result = await cost.costs({ days: 2, apiId: 'abc' });

    assert.deepStrictEqual(result.buckets, ['2026-10-03', '2026-10-04']);
    assert.strictEqual(result.budgetUsd, 5);
    const by = Object.fromEntries(result.estimated.byService.map(s => [s.service, s]));
    // 1000 s × 0,5 GB × preço + 1000 requisições
    close(by[SERVICES.lambda].values[1], 1000 * 0.5 * PRICES.lambdaGbSecondArm + 1000 * PRICES.lambdaRequest);
    close(by[SERVICES.stepFunctions].values[0], 100 * TRANSITIONS_PER_SAGA * PRICES.stepFunctionsTransition);
    close(by[SERVICES.apiGateway].total, 2000 * PRICES.httpApiRequest);
    close(by[SERVICES.dynamodb].total, 4000 * PRICES.dynamoReadUnit + 1000 * PRICES.dynamoWriteUnit);
    close(result.estimated.total, result.estimated.byService.reduce((sum, s) => sum + s.total, 0));

    const api = cloudwatch.sent.find(c => c.name === 'GetMetricDataCommand').input.MetricDataQueries.find(q => q.Id === 'api');
    assert.deepStrictEqual(api.MetricStat.Metric.Dimensions, [{ Name: 'ApiId', Value: 'abc' }, { Name: 'Stage', Value: 'dev' }]);
  });

  it('AWS: custo real do Cost Explorer recortado no período, mês até hoje e previsão', async () => {
    const costExplorer = fakeCostExplorer({
      days: {
        '2026-09-30': { 'AWS Lambda': 9 },
        '2026-10-01': { 'AWS Lambda': 0.5 },
        '2026-10-04': { 'AWS Lambda': 0.25, 'Amazon DynamoDB': 0.1 }
      },
      forecast: 2
    });
    const cost = new CostClient({ cloudwatch: fakeCloudWatch({}), costExplorer, local: false, now: () => NOW, env: {} });
    const result = await cost.costs({ days: 2 });

    assert.deepStrictEqual(result.actual.byService.map(s => [s.service, s.values]), [['AWS Lambda', [0, 0.25]], ['Amazon DynamoDB', [0, 0.1]]]);
    close(result.actual.total, 0.35);
    close(result.actual.monthToDate, 0.85);
    close(result.forecast.monthTotal, 2.85);

    const [usage, forecast] = costExplorer.sent;
    assert.strictEqual(usage.input.TimePeriod.End, '2026-10-05');
    assert.strictEqual(usage.input.TimePeriod.Start, '2026-07-07');
    assert.deepStrictEqual(forecast.input.TimePeriod, { Start: '2026-10-05', End: '2026-11-01' });
  });

  it('Cost Explorer lido uma vez a cada 6 h, qualquer que seja o período', async () => {
    let now = NOW;
    const costExplorer = fakeCostExplorer();
    const cost = new CostClient({ cloudwatch: fakeCloudWatch({}), costExplorer, local: false, now: () => now, env: {} });
    await cost.costs({ days: 7 });
    await cost.costs({ days: 30 });
    assert.strictEqual(costExplorer.sent.length, 2);
    now += 6 * 60 * 60 * 1000 + 1;
    await cost.costs({ days: 7 });
    assert.strictEqual(costExplorer.sent.length, 4);
  });

  it('falha do Cost Explorer não derruba a estimativa', async () => {
    const cost = new CostClient({ cloudwatch: fakeCloudWatch({}), costExplorer: fakeCostExplorer({ fail: true }), local: false, now: () => NOW, env: {} });
    const result = await cost.costs({ days: 7 });
    assert.strictEqual(result.actual, null);
    assert.match(result.actualReason, /AccessDenied/);
    assert.ok(result.estimated);
  });

  it('estimativa fora do ar não esconde o custo real; sem nenhum dos dois, erro (503)', async () => {
    const broken = { async send() { throw new Error('CloudWatch down'); } };
    const ok = new CostClient({ cloudwatch: broken, costExplorer: fakeCostExplorer({ days: { '2026-10-04': { 'AWS Lambda': 1 } } }), local: false, now: () => NOW, env: {} });
    const result = await ok.costs({ days: 1 });
    assert.strictEqual(result.estimated, null);
    assert.match(result.estimatedError, /CloudWatch down/);
    close(result.actual.total, 1);

    const none = new CostClient({ cloudwatch: broken, local: true, now: () => NOW, env: {} });
    await assert.rejects(none.costs({ days: 1 }), /CloudWatch down/);
  });

  it('AWS: o authorizer (sem MemoryUsedMB) entra na estimativa com o MemorySize dele', async () => {
    const cloudwatch = fakeCloudWatch({
      functions: [],
      data: { lambda_ms_0: [[new Date(TODAY), 1_000_000]], lambda_n_0: [[new Date(TODAY), 100]] }
    });
    const cost = new CostClient({ cloudwatch, costExplorer: fakeCostExplorer(), local: false, now: () => NOW, env: { AUTHORIZER_FUNCTION_NAME: 'dev-Authorizer', AUTHORIZER_MEMORY_MB: '128' } });
    const result = await cost.costs({ days: 1 });
    const query = cloudwatch.sent.find(c => c.name === 'GetMetricDataCommand').input.MetricDataQueries[0];
    assert.deepStrictEqual(query.MetricStat.Metric.Dimensions, [{ Name: 'FunctionName', Value: 'dev-Authorizer' }]);
    close(result.estimated.byService[0].total, 1000 * 0.125 * PRICES.lambdaGbSecondArm + 100 * PRICES.lambdaRequest);
  });

  it('local: estimativa pelo InvocationDurationMs, sem Cost Explorer', async () => {
    const cloudwatch = fakeCloudWatch({
      functions: ['local-OrderFunction', 'local-server'],
      data: {
        lambda_ms_0: [[new Date(TODAY), 2000]],
        lambda_n_0: [[new Date(TODAY), 10]],
        lambda_ms_1: [[new Date(TODAY), 3000]],
        lambda_n_1: [[new Date(TODAY), 50]]
      }
    });
    const cost = new CostClient({ cloudwatch, local: true, now: () => NOW, env: { FUNCTION_MEMORY_MB: '256' } });
    const result = await cost.costs({ days: 1 });

    assert.strictEqual(result.actual, null);
    assert.match(result.actualReason, /LocalStack/);
    const by = Object.fromEntries(result.estimated.byService.map(s => [s.service, s.total]));
    close(by[SERVICES.lambda], 5 * 0.25 * PRICES.lambdaGbSecondArm + 60 * PRICES.lambdaRequest);
    // 10 passos da saga (local-*) × 2 transições; 50 requisições no local-server
    close(by[SERVICES.stepFunctions], 20 * PRICES.stepFunctionsTransition);
    close(by[SERVICES.apiGateway], 50 * PRICES.httpApiRequest);
    const query = cloudwatch.sent.find(c => c.name === 'GetMetricDataCommand').input.MetricDataQueries[0];
    assert.strictEqual(query.MetricStat.Metric.MetricName, 'InvocationDurationMs');
  });
});

describe('GET /metrics/memory e /metrics/cost', () => {
  const req = (path, query, requestContext = {}) => ({ requestContext: { http: { method: 'GET' }, ...requestContext }, rawPath: path, headers: {}, queryStringParameters: query });

  it('repassam o período (e o apiId do HttpApi para o custo)', async () => {
    let memoryArgs, costArgs;
    const handler = createAPIHandler({
      memory: { async memoryMetrics(args) { memoryArgs = args; return { functions: [] }; } },
      cost: { async costs(args) { costArgs = args; return { estimated: { total: 0 } }; } }
    });
    assert.strictEqual((await handler(req('/metrics/memory', { hours: '3' }))).statusCode, 200);
    assert.deepStrictEqual(memoryArgs, { hours: 3 });
    assert.strictEqual((await handler(req('/metrics/cost', { days: '30' }, { apiId: 'abc' }))).statusCode, 200);
    assert.deepStrictEqual(costArgs, { days: 30, apiId: 'abc' });
  });

  it('503 quando a leitura falha', async () => {
    const handler = createAPIHandler({
      memory: { async memoryMetrics() { throw new Error('boom'); } },
      cost: { async costs() { throw new Error('boom'); } }
    });
    assert.strictEqual((await handler(req('/metrics/memory'))).statusCode, 503);
    assert.strictEqual((await handler(req('/metrics/cost'))).statusCode, 503);
  });

  it('memória e custo são públicos', () => {
    assert.strictEqual(isAdminRoute('GET', '/metrics/memory'), false);
    assert.strictEqual(isAdminRoute('GET', '/metrics/cost'), false);
  });
});
