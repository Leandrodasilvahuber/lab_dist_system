import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryMetricsClient, memoryLimitFor } from '../../../src/layers/api-gateway-layer/src/services/MemoryMetricsClient.js';
import { CostClient, parseCostQuery, snapshotStore, PRICES, SERVICES, TRANSITIONS_PER_SAGA } from '../../../src/layers/api-gateway-layer/src/services/CostClient.js';
import { CostRefreshLimitError } from '../../../src/common/errors.mjs';
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
      data: { max_0: [[minute(30), 90], [minute(10), 120.04]], max_2: [[minute(5), 300]] }
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
    // Só o máximo: uma série por função no GetMetricData
    const queries = client.sent.find(c => c.name === 'GetMetricDataCommand').input.MetricDataQueries;
    assert.deepStrictEqual(queries.map(q => [q.Id, q.MetricStat.Stat]), [['max_0', 'Maximum'], ['max_1', 'Maximum'], ['max_2', 'Maximum']]);
    assert.strictEqual('avg' in order, false);
  });

  it('mais de um ponto no balde: fica o maior', async () => {
    const t = minute(30);
    const client = fakeCloudWatch({ functions: ['fn'], data: { max_0: [[t, 90], [t, 110]] } });
    const result = await new MemoryMetricsClient({ client, now: () => NOW }).memoryMetrics({ hours: 1 });
    const index = result.functions[0].max.findIndex(v => v !== null);
    assert.strictEqual(result.functions[0].max[index], 110);
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

// CostSnapshotsTable em memória, com a mesma trava de snapshotStore
function fakeStore(initial = null) {
  return {
    item: initial,
    async get() { return this.item?.fetchedAt ? this.item : null; },
    async tryLock(now, minIntervalMs, quota) {
      const lockedAt = this.item?.refreshStartedAt;
      if (lockedAt !== undefined && lockedAt >= now - minIntervalMs) return { acquired: false, lockedAt };
      if (quota) {
        const count = this.item?.manualDay === quota.day ? this.item.manualCount : 0;
        if (count >= quota.limit) return { acquired: false, limitReached: true };
        this.item = { ...this.item, manualDay: quota.day, manualCount: count + 1 };
      }
      this.item = { ...this.item, refreshStartedAt: now };
      return { acquired: true };
    },
    // Update como o snapshotStore: preserva o contador do dia
    async save(snapshot) { this.item = { ...this.item, ...snapshot }; }
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
      store: fakeStore(),
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

  it('AWS: leitura do Cost Explorer gravada e recortada no período, mês até hoje e previsão', async () => {
    const costExplorer = fakeCostExplorer({
      days: {
        '2026-09-30': { 'AWS Lambda': 9 },
        '2026-10-01': { 'AWS Lambda': 0.5 },
        '2026-10-04': { 'AWS Lambda': 0.25, 'Amazon DynamoDB': 0.1 }
      },
      forecast: 2
    });
    const store = fakeStore();
    const cost = new CostClient({ cloudwatch: fakeCloudWatch({}), costExplorer, store, local: false, now: () => NOW, env: {} });
    assert.deepStrictEqual(await cost.refreshActual(), { refreshed: true, fetchedAt: new Date(NOW).toISOString() });
    assert.deepStrictEqual(store.item.byService['AWS Lambda'], { '2026-09-30': 9, '2026-10-01': 0.5, '2026-10-04': 0.25 });

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

  it('GET nunca chama o Cost Explorer: só lê a última leitura gravada', async () => {
    let now = NOW;
    const costExplorer = fakeCostExplorer();
    const cost = new CostClient({ cloudwatch: fakeCloudWatch({}), costExplorer, store: fakeStore(), local: false, now: () => now, env: {} });
    const empty = await cost.costs({ days: 7 });
    assert.strictEqual(empty.actual, null);
    assert.match(empty.actualReason, /ainda não lido/);
    now += 7 * 60 * 60 * 1000;
    await cost.costs({ days: 30 });
    assert.strictEqual(costExplorer.sent.length, 0);
  });

  it('no máximo uma leitura do Cost Explorer a cada 15 min', async () => {
    let now = NOW;
    const costExplorer = fakeCostExplorer();
    const cost = new CostClient({ cloudwatch: fakeCloudWatch({}), costExplorer, store: fakeStore(), local: false, now: () => now, env: {} });
    await cost.refreshActual();
    assert.strictEqual(costExplorer.sent.length, 2);
    now += 5 * 60 * 1000;
    assert.deepStrictEqual(await cost.refreshActual(), { refreshed: false, retryAt: new Date(NOW + 15 * 60 * 1000).toISOString() });
    assert.strictEqual(costExplorer.sent.length, 2);
    now = NOW + 15 * 60 * 1000 + 1;
    assert.strictEqual((await cost.refreshActual()).refreshed, true);
    assert.strictEqual(costExplorer.sent.length, 4);
  });

  it('leitura manual: até o limite do dia, depois 429 até as 12:00; a agendada não conta', async () => {
    let now = NOW;
    const store = fakeStore();
    const cost = new CostClient({ cloudwatch: fakeCloudWatch({}), costExplorer: fakeCostExplorer(), store, local: false, now: () => now, env: { COST_REFRESH_DAILY_LIMIT: '2' } });
    const next = () => { now += 15 * 60 * 1000 + 1; };
    await cost.refreshActual({ manual: true });
    next();
    await cost.refreshActual({ manual: true });
    next();
    const error = await cost.refreshActual({ manual: true }).catch(e => e);
    assert.ok(error instanceof CostRefreshLimitError);
    // NOW é 09:00 em Brasília: o dia de cota zera às 12:00 (15:00 UTC)
    assert.strictEqual(error.resetsAt, '2026-10-04T15:00:00.000Z');
    assert.strictEqual(error.retryAfterSeconds, Math.ceil((Date.parse('2026-10-04T15:00:00Z') - now) / 1000));
    // A regra agendada continua lendo
    assert.strictEqual((await cost.refreshActual()).refreshed, true);
    now = Date.parse('2026-10-04T15:00:00Z');
    assert.strictEqual((await cost.refreshActual({ manual: true })).refreshed, true);
    assert.deepStrictEqual([store.item.manualDay, store.item.manualCount], ['2026-10-04', 1]);
  });

  it('snapshotStore: leitura manual conta no dia na mesma escrita da trava', async () => {
    const quota = { day: '2026-10-04', limit: 5 };
    const failWith = Item => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException', Item });
    // Mesmo dia, limite atingido: uma escrita só
    let sent = [];
    let client = { async send(command) { sent.push(command); throw failWith({ refreshStartedAt: { N: '1' }, manualDay: { S: quota.day }, manualCount: { N: '5' } }); } };
    assert.deepStrictEqual(await snapshotStore('t', client).tryLock(NOW, 1000, quota), { acquired: false, limitReached: true });
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].input.ConditionExpression, /manualCount < :limit/);
    // Dia novo: a segunda escrita recomeça o contador
    sent = [];
    client = { async send(command) { sent.push(command); if (sent.length === 1) throw failWith({ manualDay: { S: '2026-10-03' }, manualCount: { N: '5' } }); return {}; } };
    assert.deepStrictEqual(await snapshotStore('t', client).tryLock(NOW, 1000, quota), { acquired: true });
    assert.match(sent[1].input.UpdateExpression, /manualDay = :day, manualCount = :one/);
    // Travado (leitura há menos de minIntervalMs): 429 de 15 min, não o do dia
    client = { async send() { throw failWith({ refreshStartedAt: { N: String(NOW) }, manualDay: { S: quota.day }, manualCount: { N: '5' } }); } };
    assert.deepStrictEqual(await snapshotStore('t', client).tryLock(NOW + 10, 1000, quota), { acquired: false, lockedAt: NOW });
  });

  it('snapshotStore.save: Update só dos campos da leitura, sem tocar no contador do dia', async () => {
    const sent = [];
    const store = snapshotStore('t', { async send(command) { sent.push(command); return {}; } });
    await store.save({ fetchedAt: 'x', monthToDate: 1.5, forecast: null, refreshStartedAt: NOW, skipped: undefined });
    const { input } = sent[0];
    assert.strictEqual(sent[0].constructor.name, 'UpdateCommand');
    assert.deepStrictEqual(Object.values(input.ExpressionAttributeNames), ['fetchedAt', 'monthToDate', 'forecast', 'refreshStartedAt']);
    assert.doesNotMatch(input.UpdateExpression, /manual/);
  });

  it('local: não há Cost Explorer para atualizar (503)', async () => {
    const cost = new CostClient({ cloudwatch: fakeCloudWatch({}), local: true, now: () => NOW, env: {} });
    await assert.rejects(cost.refreshActual(), err => err.statusCode === 503);
  });

  it('snapshotStore: trava condicional no DynamoDB', async () => {
    const sent = [];
    const client = {
      async send(command) {
        sent.push(command);
        if (sent.length === 2) {
          throw Object.assign(new Error('locked'), { name: 'ConditionalCheckFailedException', Item: { refreshStartedAt: { N: String(NOW) } } });
        }
        return {};
      }
    };
    const store = snapshotStore('dev-CostSnapshots', client);
    assert.deepStrictEqual(await store.tryLock(NOW, 1000), { acquired: true });
    assert.strictEqual(sent[0].input.ExpressionAttributeValues[':cutoff'], NOW - 1000);
    assert.match(sent[0].input.ConditionExpression, /refreshStartedAt < :cutoff/);
    assert.deepStrictEqual(await store.tryLock(NOW + 10, 1000), { acquired: false, lockedAt: NOW });
  });

  it('falha do Cost Explorer não derruba a estimativa', async () => {
    const cost = new CostClient({ cloudwatch: fakeCloudWatch({}), costExplorer: fakeCostExplorer({ fail: true }), store: fakeStore(), local: false, now: () => NOW, env: {} });
    await assert.rejects(cost.refreshActual(), /AccessDenied/);
    const result = await cost.costs({ days: 7 });
    assert.strictEqual(result.actual, null);
    assert.ok(result.estimated);
  });

  it('DynamoDB fora do ar não derruba a estimativa', async () => {
    const store = { async get() { throw new Error('Throttled'); } };
    const cost = new CostClient({ cloudwatch: fakeCloudWatch({}), store, local: false, now: () => NOW, env: {} });
    const result = await cost.costs({ days: 7 });
    assert.strictEqual(result.actual, null);
    assert.match(result.actualReason, /Throttled/);
    assert.ok(result.estimated);
  });

  it('estimativa fora do ar não esconde o custo real; sem nenhum dos dois, erro (503)', async () => {
    const broken = { async send() { throw new Error('CloudWatch down'); } };
    const ok = new CostClient({ cloudwatch: broken, costExplorer: fakeCostExplorer({ days: { '2026-10-04': { 'AWS Lambda': 1 } } }), store: fakeStore(), local: false, now: () => NOW, env: {} });
    await ok.refreshActual();
    const result = await ok.costs({ days: 1 });
    assert.strictEqual(result.estimated, null);
    assert.match(result.estimatedError, /CloudWatch down/);
    close(result.actual.total, 1);

    const none = new CostClient({ cloudwatch: broken, local: true, now: () => NOW, env: {} });
    await assert.rejects(none.costs({ days: 1 }), /CloudWatch down/);
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

  it('POST /metrics/cost/refresh: 200, 429 com Retry-After quando travado, 503 se falhar', async () => {
    const results = [
      { refreshed: true, fetchedAt: '2026-10-04T12:00:00.000Z' },
      { refreshed: false, retryAt: new Date(Date.now() + 90 * 1000).toISOString() }
    ];
    const handler = createAPIHandler({ cost: { async refreshActual() { return results.shift(); } } });
    const post = { requestContext: { http: { method: 'POST' } }, rawPath: '/metrics/cost/refresh', headers: {} };
    assert.strictEqual((await handler(post)).statusCode, 200);
    const locked = await handler(post);
    assert.strictEqual(locked.statusCode, 429);
    assert.ok(Number(locked.headers['Retry-After']) >= 89);
    const failing = createAPIHandler({ cost: { async refreshActual() { throw new Error('AccessDenied'); } } });
    assert.strictEqual((await failing(post)).statusCode, 503);
  });

  it('POST /metrics/cost/refresh: leitura manual e 429 com code quando passa do limite do dia', async () => {
    const calls = [];
    const limited = new CostRefreshLimitError(5, { resetsAt: '2026-10-04T15:00:00.000Z', retryAfterSeconds: 600 });
    const handler = createAPIHandler({ cost: { async refreshActual(options) { calls.push(options); throw limited; } } });
    const response = await handler({ requestContext: { http: { method: 'POST' } }, rawPath: '/metrics/cost/refresh', headers: {} });
    assert.deepStrictEqual(calls, [{ manual: true }]);
    assert.strictEqual(response.statusCode, 429);
    assert.strictEqual(response.headers['Retry-After'], '600');
    assert.deepStrictEqual(JSON.parse(response.body), {
      error: limited.message, code: 'CostRefreshLimitExceeded', limit: 5, resetsAt: '2026-10-04T15:00:00.000Z'
    });
  });

  it('a regra agendada lê o Cost Explorer', async () => {
    let calls = 0;
    const handler = createAPIHandler({ cost: { async refreshActual() { calls++; return { refreshed: true }; } } });
    assert.deepStrictEqual(await handler({ action: 'refreshCost' }), { refreshed: true });
    assert.strictEqual(calls, 1);
  });

  it('503 quando a leitura falha', async () => {
    const handler = createAPIHandler({
      memory: { async memoryMetrics() { throw new Error('boom'); } },
      cost: { async costs() { throw new Error('boom'); } }
    });
    assert.strictEqual((await handler(req('/metrics/memory'))).statusCode, 503);
    assert.strictEqual((await handler(req('/metrics/cost'))).statusCode, 503);
  });

  it('memória (GetMetricData) e custo (conta AWS inteira) são de admin', () => {
    assert.strictEqual(isAdminRoute('GET', '/metrics/memory'), true);
    assert.strictEqual(isAdminRoute('GET', '/metrics/cost'), true);
    assert.strictEqual(isAdminRoute('POST', '/metrics/cost/refresh'), true);
  });
});
