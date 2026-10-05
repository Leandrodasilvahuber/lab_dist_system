import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SloClient, percentile, parseSloQuery, SLO_HOURS, SLO_TARGETS, STUCK_AFTER_MS } from '../../../src/layers/api-gateway-layer/src/services/SloClient.js';
import { createAPIHandler } from '../../../src/layers/api-gateway-layer/src/routes/apiRoutes.js';
import { isAdminRoute } from '../../../src/common/auth.mjs';
import { SAGAS_BY_DAY_INDEX, SAGA_DAY_SHARDS, sagaDayShard } from '../../../src/common/saga-day-index.mjs';

process.env.LOG_LEVEL = 'silent';

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const iso = ms => new Date(ms).toISOString();

// Saga criada `ago` ms atrás que levou `durationMs` até o último status
function saga(status, { ago = HOUR, durationMs = 1000 } = {}) {
  const id = `saga_${Math.random()}`;
  const createdAt = iso(NOW - ago);
  return { id, status, createdAt, updatedAt: iso(NOW - ago + durationMs), dayShard: sagaDayShard(id, createdAt) };
}

// Responde as Queries no SagasByDayIndex como o DynamoDB; `keys` guarda cada dia#shard consultado
function fakeDb(sagas) {
  return {
    keys: [],
    async queryItems(table, params) {
      assert.strictEqual(table, 'sagas');
      assert.strictEqual(params.IndexName, SAGAS_BY_DAY_INDEX);
      const { ':dayShard': dayShard, ':since': since } = params.ExpressionAttributeValues;
      this.keys.push(dayShard);
      return sagas.filter(s => s.dayShard === dayShard && s.createdAt >= since);
    },
    async scanItems() { throw new Error('a aba SLOs não pode varrer a tabela'); }
  };
}

function fakeDlq(messages = [], approximateTotal = messages.length) {
  return { async listMessages() { return { queue: 'dev-ProductEventsDlq', approximateTotal, messages }; } };
}

function client({ sagas = [], dlq = fakeDlq(), now = () => NOW } = {}) {
  return new SloClient({ db: fakeDb(sagas), dlq, now });
}

const byId = (result, id) => result.slos.find(slo => slo.id === id);

describe('percentile', () => {
  it('usa nearest-rank e não altera a entrada', () => {
    const values = [5, 1, 4, 2, 3];
    assert.strictEqual(percentile(values, 50), 3);
    assert.strictEqual(percentile(values, 95), 5);
    assert.deepStrictEqual(values, [5, 1, 4, 2, 3]);
  });

  it('com 100 valores, p95 é o 95º', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.strictEqual(percentile(values, 95), 95);
    assert.strictEqual(percentile(values, 99), 99);
  });

  it('vazio -> null; um valor -> ele mesmo', () => {
    assert.strictEqual(percentile([], 95), null);
    assert.strictEqual(percentile([42], 95), 42);
  });
});

describe('parseSloQuery', () => {
  it('padrão 24 h, máximo 7 dias', () => {
    assert.deepStrictEqual(parseSloQuery(), { hours: 24 });
    assert.deepStrictEqual(parseSloQuery({ hours: 'x' }), { hours: 24 });
    assert.deepStrictEqual(parseSloQuery({ hours: '1' }), { hours: 1 });
    assert.deepStrictEqual(parseSloQuery({ hours: '9999' }), { hours: 168 });
    // Período fixo: é a chave do cache, outros valores furariam o cache
    assert.deepStrictEqual(parseSloQuery({ hours: '1.0001' }), { hours: 1 });
    assert.deepStrictEqual(parseSloQuery({ hours: '23.6' }), { hours: 24 });
    assert.deepStrictEqual(parseSloQuery({ hours: '0.2' }), { hours: 1 });
    assert.deepStrictEqual(parseSloQuery({ hours: '3' }), { hours: 1 });
    assert.deepStrictEqual(parseSloQuery({ hours: '72' }), { hours: 24 });
    const seen = new Set();
    for (let h = 0; h <= 400; h++) seen.add(parseSloQuery({ hours: String(h) }).hours);
    assert.deepStrictEqual([...seen].sort((a, b) => a - b), SLO_HOURS);
  });
});

describe('SloClient', () => {
  it('p95 só das compras concluídas dentro da janela', async () => {
    const sagas = [
      ...Array.from({ length: 19 }, () => saga('COMPLETED', { durationMs: 500 })),
      saga('COMPLETED', { durationMs: 3000 }),
      saga('COMPENSATED', { durationMs: 9000 }),
      saga('COMPLETED', { ago: 30 * HOUR, durationMs: 9000 })
    ];
    const latency = byId(await client({ sagas }).evaluate({ hours: 24 }), 'purchase-latency');

    assert.strictEqual(latency.sample, 20);
    assert.strictEqual(latency.value, 500);
    assert.strictEqual(latency.ok, true);
    assert.strictEqual(latency.detail.max, 3000);
  });

  it('p95 acima de 2 s viola o SLO', async () => {
    const sagas = [saga('COMPLETED', { durationMs: 2500 })];
    const latency = byId(await client({ sagas }).evaluate(), 'purchase-latency');
    assert.strictEqual(latency.value, 2500);
    assert.strictEqual(latency.ok, false);
  });

  it('compensação conta como desfecho aceito; em andamento fica fora da razão', async () => {
    const sagas = [
      ...Array.from({ length: 150 }, () => saga('COMPLETED')),
      ...Array.from({ length: 49 }, () => saga('COMPENSATED')),
      saga('COMPENSATION_FAILED'),
      saga('RUNNING', { ago: 1000, durationMs: 0 }),
      saga('COMPENSATING', { ago: STUCK_AFTER_MS + 1000, durationMs: 0 })
    ];
    const outcome = byId(await client({ sagas }).evaluate(), 'saga-outcome');

    assert.strictEqual(outcome.sample, 200);
    assert.strictEqual(outcome.value, 0.995);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.detail.byStatus.COMPENSATION_FAILED, 1);
    assert.strictEqual(outcome.detail.inProgress, 2);
    assert.strictEqual(outcome.detail.stuck, 1);
  });

  it('abaixo de 99,5% viola o SLO', async () => {
    const sagas = [...Array.from({ length: 99 }, () => saga('COMPLETED')), saga('FAILED')];
    const outcome = byId(await client({ sagas }).evaluate(), 'saga-outcome');
    assert.strictEqual(outcome.value, 0.99);
    assert.strictEqual(outcome.ok, false);
  });

  it('sem amostra: ok null (nem verde nem vermelho)', async () => {
    const result = await client({ sagas: [saga('RUNNING')] }).evaluate();
    assert.strictEqual(byId(result, 'purchase-latency').ok, null);
    assert.strictEqual(byId(result, 'saga-outcome').ok, null);
    assert.strictEqual(byId(result, 'dlq-age').ok, true);
  });

  it('DLQ: só mensagens com mais de 24 h violam', async () => {
    const dlq = fakeDlq([{ sentAt: iso(NOW - 25 * HOUR) }, { sentAt: iso(NOW - HOUR) }], 60);
    const age = byId(await client({ dlq }).evaluate(), 'dlq-age');

    assert.strictEqual(age.value, 1);
    assert.strictEqual(age.ok, false);
    assert.strictEqual(age.target, 0);
    assert.strictEqual(age.detail.oldestAgeMs, 25 * HOUR);
    assert.strictEqual(age.detail.partial, true);
  });

  it('DLQ só com mensagens recentes está OK', async () => {
    const age = byId(await client({ dlq: fakeDlq([{ sentAt: iso(NOW - HOUR) }]) }).evaluate(), 'dlq-age');
    assert.strictEqual(age.value, 0);
    assert.strictEqual(age.ok, true);
  });

  it('reaproveita a leitura por janela dentro do TTL', async () => {
    const db = fakeDb([]);
    const slo = new SloClient({ db, dlq: fakeDlq(), now: () => NOW });
    await slo.evaluate({ hours: 24 });
    await slo.evaluate({ hours: 24 });
    assert.strictEqual(db.keys.length, 2 * SAGA_DAY_SHARDS);
    await slo.evaluate({ hours: 1 });
    assert.strictEqual(db.keys.length, 3 * SAGA_DAY_SHARDS);
  });

  it('consulta o índice por dia e shard, sem Scan: 24 h cruzando a meia-noite = 2 dias', async () => {
    const db = fakeDb([]);
    await new SloClient({ db, dlq: fakeDlq(), now: () => NOW }).evaluate({ hours: 24 });
    assert.strictEqual(db.keys.length, 2 * SAGA_DAY_SHARDS);
    assert.ok(db.keys.includes('2026-10-03#0'));
    assert.ok(db.keys.includes(`2026-10-04#${SAGA_DAY_SHARDS - 1}`));
  });

  it('janela de 7 dias consulta 8 dias de shards e junta as sagas de todos', async () => {
    const sagas = [saga('COMPLETED', { ago: 6 * 24 * HOUR }), saga('COMPLETED', { ago: HOUR }), saga('COMPLETED', { ago: 8 * 24 * HOUR })];
    const db = fakeDb(sagas);
    const result = await new SloClient({ db, dlq: fakeDlq(), now: () => NOW }).evaluate({ hours: 168 });
    assert.strictEqual(db.keys.length, 8 * SAGA_DAY_SHARDS);
    assert.strictEqual(byId(result, 'purchase-latency').sample, 2);
  });

  it('usa as metas de SLO_TARGETS', async () => {
    const result = await client().evaluate();
    assert.strictEqual(byId(result, 'purchase-latency').target, SLO_TARGETS.purchaseP95Ms);
    assert.strictEqual(byId(result, 'saga-outcome').target, SLO_TARGETS.sagaSuccessRatio);
    assert.strictEqual(result.windowHours, 24);
  });
});

describe('GET /metrics/slo', () => {
  const request = query => ({ requestContext: { http: { method: 'GET', path: '/metrics/slo' } }, rawPath: '/metrics/slo', queryStringParameters: query, headers: {} });

  it('devolve a avaliação com a janela pedida', async () => {
    let received;
    const handler = createAPIHandler({ slo: { async evaluate(args) { received = args; return { windowHours: args.hours, slos: [] }; } } });
    const response = await handler(request({ hours: '1' }));

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(received, { hours: 1 });
    assert.strictEqual(JSON.parse(response.body).windowHours, 1);
  });

  it('503 quando a leitura falha', async () => {
    const handler = createAPIHandler({ slo: { async evaluate() { throw new Error('boom'); } } });
    const response = await handler(request());
    assert.strictEqual(response.statusCode, 503);
  });

  it('é rota pública', () => {
    assert.strictEqual(isAdminRoute('GET', '/metrics/slo'), false);
  });
});
