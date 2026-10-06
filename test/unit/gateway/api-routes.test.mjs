import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AlarmsClient } from '../../../src/layers/api-gateway-layer/src/services/AlarmsClient.js';
import { authConfig, createAPIHandler } from '../../../src/layers/api-gateway-layer/src/routes/apiRoutes.js';
import { LogsClient } from '../../../src/layers/api-gateway-layer/src/services/LogsClient.js';
import { ChaosClient } from '../../../src/layers/api-gateway-layer/src/services/ChaosClient.js';
import { MAX_RESET_CONTINUATIONS, ResetClient } from '../../../src/layers/api-gateway-layer/src/services/ResetClient.js';
import { SEED_PRODUCTS } from '../../../src/common/seed-products.mjs';

process.env.LOG_LEVEL = 'silent';

const getAlarms = { requestContext: { http: { method: 'GET', path: '/alarms' } }, rawPath: '/alarms', headers: {} };

function fakeCloudWatch(response) {
  return {
    sent: [],
    async send(command) {
      this.sent.push(command.input);
      if (response instanceof Error) throw response;
      return response;
    }
  };
}

describe('AlarmsClient', () => {
  it('filtra pelo prefixo, mapeia os campos e põe ALARM primeiro', async () => {
    const client = fakeCloudWatch({
      MetricAlarms: [
        { AlarmName: 'dev-ecommerce-b', StateValue: 'OK', StateReason: 'ok', StateUpdatedTimestamp: new Date('2026-10-04T10:00:00Z') },
        { AlarmName: 'dev-ecommerce-a', AlarmDescription: 'DLQ', StateValue: 'ALARM', StateReason: 'Threshold crossed' }
      ]
    });
    const alarms = await new AlarmsClient({ prefix: 'dev-ecommerce-', client }).listAlarms();

    assert.strictEqual(client.sent[0].AlarmNamePrefix, 'dev-ecommerce-');
    assert.deepStrictEqual(alarms, [
      { name: 'dev-ecommerce-a', description: 'DLQ', state: 'ALARM', reason: 'Threshold crossed', updatedAt: null },
      { name: 'dev-ecommerce-b', description: null, state: 'OK', reason: 'ok', updatedAt: '2026-10-04T10:00:00.000Z' }
    ]);
  });

  it('abas abertas dividem a mesma leitura por 20 s; falha não fica no cache', async () => {
    let clock = 0;
    const client = fakeCloudWatch({ MetricAlarms: [] });
    const alarms = new AlarmsClient({ client, now: () => clock });
    await alarms.listAlarms();
    await alarms.listAlarms();
    assert.strictEqual(client.sent.length, 1);
    clock = 20001;
    await alarms.listAlarms();
    assert.strictEqual(client.sent.length, 2);

    const failing = new AlarmsClient({ client: fakeCloudWatch(new Error('Throttling')), now: () => clock });
    await assert.rejects(failing.listAlarms());
    await assert.rejects(failing.listAlarms());
    assert.strictEqual(failing.client.sent.length, 2);
  });
});

describe('GET /alarms', () => {
  it('devolve { alarms }', async () => {
    const handler = createAPIHandler({ alarms: { listAlarms: async () => [{ name: 'x', state: 'OK' }] } });
    const response = await handler(getAlarms);
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { alarms: [{ name: 'x', state: 'OK' }] });
  });

  it('CloudWatch indisponível vira 503', async () => {
    const handler = createAPIHandler({ alarms: { listAlarms: async () => { throw new Error('AccessDenied'); } } });
    const response = await handler(getAlarms);
    assert.strictEqual(response.statusCode, 503);
    assert.deepStrictEqual(JSON.parse(response.body), { error: 'Alarms unavailable' });
  });
});

describe('GET /logs', () => {
  const getLogs = query => ({ requestContext: { http: { method: 'GET' } }, rawPath: '/logs', headers: {}, queryStringParameters: query });

  // CloudWatch Logs falso: devolve as linhas da janela pedida, da mais antiga
  // para a mais nova, em páginas de 100
  function fakeLogs(lines) {
    return {
      sent: [],
      async send({ input }) {
        this.sent.push(input);
        const events = lines
          .filter(line => {
            const at = Date.parse(JSON.parse(line.slice(line.indexOf('{'))).timestamp);
            return at >= input.startTime && at <= input.endTime;
          })
          .sort((a, b) => a.localeCompare(b))
          .map(message => ({ message }));
        const offset = Number(input.nextToken || 0);
        const next = offset + 100;
        return { events: events.slice(offset, next), ...(next < events.length && { nextToken: String(next) }) };
      }
    };
  }
  const line = (timestamp, event, status = 'error') => JSON.stringify({ timestamp, event, status });

  it('LogsClient filtra warn/error no log group e devolve as linhas parseadas, mais recentes primeiro', async () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    const client = fakeLogs([line('2026-10-04T10:30:00Z', 'A', 'warn'), line('2026-10-04T11:30:00Z', 'B'), `${line('2026-10-04T11:40:00Z', 'C')}\n`]);
    const logs = await new LogsClient({ logGroupName: '/aws/lambda/dev-ecommerce', client }).listLogs({ levels: ['warn', 'error'], hours: 2 }, now);

    assert.strictEqual(client.sent[0].logGroupName, '/aws/lambda/dev-ecommerce');
    assert.strictEqual(client.sent[0].filterPattern, '{ ($.status = "warn") || ($.status = "error") }');
    // Da janela mais recente para a mais antiga, sem sobrepor a borda
    assert.deepStrictEqual(client.sent.map(({ startTime, endTime }) => [startTime, endTime]), [
      [now - 3600 * 1000, now],
      [now - 2 * 3600 * 1000, now - 3600 * 1000 - 1]
    ]);
    assert.deepStrictEqual(logs.map(l => l.event), ['C', 'B', 'A']);
  });

  it('LogsClient mostra as linhas mais recentes quando o período tem mais que o limite', async () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    const recent = Array.from({ length: 250 }, (_, i) => line(new Date(now - (i + 1) * 1000).toISOString(), `R${i}`));
    const old = Array.from({ length: 300 }, (_, i) => line(new Date(now - 5 * 3600 * 1000 - i * 1000).toISOString(), `O${i}`));
    const client = fakeLogs([...old, ...recent]);
    const logs = await new LogsClient({ logGroupName: 'g', client }).listLogs({ levels: ['error'], hours: 24 }, now);

    // A última hora (3 páginas) já basta: as janelas mais antigas nem são lidas
    assert.strictEqual(client.sent.length, 3);
    assert.ok(client.sent.every(({ startTime }) => startTime === now - 3600 * 1000));
    assert.strictEqual(logs.length, 200);
    assert.strictEqual(logs[0].event, 'R0');
    assert.ok(logs.every(l => l.event.startsWith('R')));
  });

  it('LogsClient só pede a próxima página se ela couber no timeout da Lambda', async () => {
    let clock = 0;
    const sent = [];
    const client = {
      async send(command) {
        sent.push(command.input);
        clock += 2000; // página lenta: depois de 2 delas, a 3ª (até 11s) não cabe mais
        return { events: [{ message: JSON.stringify({ timestamp: '2026-10-04T11:00:00Z', event: `P${sent.length}`, status: 'error' }) }], nextToken: 'more' };
      }
    };
    const logs = await new LogsClient({ logGroupName: 'g', client, clock: () => clock }).listLogs({ levels: ['error'], hours: 1 }, Date.parse('2026-10-04T12:00:00Z'));
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(logs.length, 2);
  });

  it('LogsClient lê até 10 páginas quando elas respondem rápido', async () => {
    let clock = 0;
    let calls = 0;
    const client = { async send() { calls += 1; clock += 300; return { events: [], nextToken: 'more' }; } };
    await new LogsClient({ logGroupName: 'g', client, clock: () => clock }).listLogs({ levels: ['error'], hours: 1 });
    assert.strictEqual(calls, 10);
  });

  it('LogsClient reaproveita a leitura por alguns segundos, por level e hours', async () => {
    let clock = 0;
    const client = fakeLogs([]);
    const logs = new LogsClient({ logGroupName: 'g', client, clock: () => clock });
    await logs.listLogs({ levels: ['error'], hours: 1 });
    await logs.listLogs({ levels: ['error'], hours: 1 });
    assert.strictEqual(client.sent.length, 1);
    await logs.listLogs({ levels: ['warn', 'error'], hours: 1 });
    assert.strictEqual(client.sent.length, 2);
    clock += 20 * 1000;
    await logs.listLogs({ levels: ['error'], hours: 1 });
    assert.strictEqual(client.sent.length, 3);
  });

  it('LogsClient.trace reaproveita a leitura e guarda no máximo 50 ids', async () => {
    let clock = 0;
    const client = fakeLogs([]);
    const logs = new LogsClient({ logGroupName: 'g', client, clock: () => clock });
    await logs.trace('saga_1');
    await logs.trace('saga_1');
    assert.strictEqual(client.sent.length, 1);
    for (let i = 0; i < 60; i++) await logs.trace(`saga_x${i}`);
    assert.strictEqual(logs.traceCache.size, 50);
    // saga_1 saiu do cache (o mais antigo) e é lido de novo
    await logs.trace('saga_1');
    assert.strictEqual(client.sent.length, 62);
  });

  it('hours fora da lista cai no período mais próximo (chave do cache)', async () => {
    let received;
    const handler = createAPIHandler({ logs: { listLogs: async query => { received = query; return []; } } });
    await handler(getLogs({ hours: '5' }));
    assert.strictEqual(received.hours, 1);
    await handler(getLogs({ hours: '100' }));
    assert.strictEqual(received.hours, 168);
  });

  it('repassa level e hours da query', async () => {
    let received;
    const handler = createAPIHandler({ logs: { listLogs: async query => { received = query; return []; } } });
    const response = await handler(getLogs({ level: 'error', hours: '1' }));
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(received, { levels: ['error'], hours: 1 });
  });

  it('CloudWatch Logs indisponível vira 503', async () => {
    const handler = createAPIHandler({ logs: { listLogs: async () => { throw new Error('AccessDenied'); } } });
    const response = await handler(getLogs({}));
    assert.strictEqual(response.statusCode, 503);
  });
});

describe('GET /health', () => {
  const req = method => ({ requestContext: { http: { method } }, rawPath: '/health', headers: {} });

  it('responde só a GET; outros métodos caem no 404', async () => {
    const handler = createAPIHandler({ alarms: {}, logs: {}, dlq: {} });
    assert.strictEqual((await handler(req('GET'))).statusCode, 200);
    assert.strictEqual((await handler(req('POST'))).statusCode, 404);
  });

  it('informa o ambiente (o dashboard enfileira as leituras no LocalStack)', async () => {
    const handler = createAPIHandler({ alarms: {}, logs: {}, dlq: {} });
    const saved = { AWS_ENDPOINT: process.env.AWS_ENDPOINT, LOCALSTACK_HOSTNAME: process.env.LOCALSTACK_HOSTNAME };
    try {
      delete process.env.AWS_ENDPOINT;
      delete process.env.LOCALSTACK_HOSTNAME;
      assert.strictEqual(JSON.parse((await handler(req('GET'))).body).environment, 'aws');
      process.env.AWS_ENDPOINT = 'http://localhost:4566';
      assert.strictEqual(JSON.parse((await handler(req('GET'))).body).environment, 'localstack');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('GET /auth/config', () => {
  it('na AWS aponta o login para o client do Cognito', () => {
    assert.deepStrictEqual(authConfig({ ADMIN_AUTH_REGION: 'us-east-1', ADMIN_AUTH_CLIENT_ID: 'abc123' }),
      { mode: 'cognito', region: 'us-east-1', clientId: 'abc123' });
  });

  it('sem client configurado (local-server), o login é pela chave', () => {
    assert.deepStrictEqual(authConfig({}), { mode: 'key' });
  });

  it('é pública e responde pelo handler', async () => {
    const handler = createAPIHandler({ alarms: {}, logs: {}, dlq: {} });
    const response = await handler({ requestContext: { http: { method: 'GET' } }, rawPath: '/auth/config', headers: {} });
    assert.strictEqual(response.statusCode, 200);
    assert.ok(['key', 'cognito'].includes(JSON.parse(response.body).mode));
  });
});

describe('GET/PUT/DELETE /chaos', () => {
  const NOW = Date.parse('2026-10-05T12:00:00Z');
  const http = (method, body) => ({ requestContext: { http: { method, path: '/chaos' } }, rawPath: '/chaos', headers: {}, body: body === undefined ? undefined : JSON.stringify(body) });

  function fakeSsm(initial) {
    return {
      value: initial,
      async send(command) {
        if (command.input.Value !== undefined) {
          this.value = command.input.Value;
          return {};
        }
        if (this.value === undefined) throw Object.assign(new Error('missing'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: this.value } };
      }
    };
  }

  // Contador de ativações em memória (mesma interface de src/common/database.mjs)
  function fakeCounters() {
    const items = new Map();
    return {
      items,
      async getItem(_table, { id }) { return items.get(id); },
      async updateItem(_table, { id }, _expression, values) {
        const item = items.get(id) || { id };
        if ((item.activations || 0) >= values[':limit']) {
          throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
        }
        item.activations = (item.activations || 0) + values[':one'];
        items.set(id, item);
        return { activations: item.activations };
      }
    };
  }

  function handlerWith(ssm, { enabled = true, limit = 20, db = fakeCounters() } = {}) {
    const chaos = new ChaosClient({ parameterName: '/test/ecommerce/chaos', enabled, limit, client: ssm, db, now: () => NOW });
    return createAPIHandler({ chaos });
  }

  it('PUT valida e grava; GET devolve a config em vigor; DELETE grava a config vazia', async () => {
    const ssm = fakeSsm(undefined);
    const handler = handlerWith(ssm);
    const expiresAt = new Date(NOW + 10 * 60000).toISOString();

    const put = await handler(http('PUT', { expiresAt, faults: [{ service: 'payments', action: 'processPayment', type: 'crash' }] }));
    assert.strictEqual(put.statusCode, 200);
    assert.strictEqual(JSON.parse(ssm.value).faults[0].probability, 1);

    const get = JSON.parse((await handler(http('GET'))).body);
    assert.deepStrictEqual([get.enabled, get.active, get.expiresAt, get.faults.length], [true, true, expiresAt, 1]);

    await handler(http('DELETE'));
    assert.deepStrictEqual(JSON.parse(ssm.value), { faults: [] });
    assert.strictEqual(JSON.parse((await handler(http('GET'))).body).active, false);
  });

  it('config inválida, expiração longa demais ou JSON quebrado: 400', async () => {
    const handler = handlerWith(fakeSsm(undefined));
    assert.strictEqual((await handler(http('PUT', { faults: [] }))).statusCode, 400);
    assert.strictEqual((await handler(http('PUT', { expiresAt: new Date(NOW + 2 * 3600000).toISOString(), faults: [] }))).statusCode, 400);
    assert.strictEqual((await handler({ ...http('PUT'), body: '{' })).statusCode, 400);
  });

  it('config expirada aparece como desligada; parâmetro ausente também', async () => {
    const expired = fakeSsm(JSON.stringify({ expiresAt: new Date(NOW - 1000).toISOString(), faults: [{ service: 'stock', type: 'crash' }] }));
    assert.strictEqual(JSON.parse((await handlerWith(expired)(http('GET'))).body).active, false);
    assert.strictEqual(JSON.parse((await handlerWith(fakeSsm(undefined))(http('GET'))).body).active, false);
  });

  it('desligado no ambiente (prod): não toca no SSM e responde enabled false', async () => {
    const ssm = { send: async () => { throw new Error('não deveria chamar'); } };
    const handler = handlerWith(ssm, { enabled: false });
    assert.strictEqual(JSON.parse((await handler(http('GET'))).body).enabled, false);
    assert.strictEqual(JSON.parse((await handler(http('PUT', {}))).body).enabled, false);
  });

  it('SSM fora do ar: 503', async () => {
    const handler = handlerWith({ send: async () => { throw new Error('timeout'); } });
    assert.strictEqual((await handler(http('GET'))).statusCode, 503);
  });

  it('ligar conta no limite do dia (429 sem gravar); desligar não conta', async () => {
    const ssm = fakeSsm(undefined);
    const db = fakeCounters();
    const handler = handlerWith(ssm, { limit: 2, db });
    const on = { expiresAt: new Date(NOW + 10 * 60000).toISOString(), faults: [{ service: 'stock', type: 'crash' }] };

    assert.strictEqual(JSON.parse((await handler(http('PUT', on))).body).remaining, 1);
    await handler(http('DELETE'));
    await handler(http('DELETE'));
    assert.strictEqual(JSON.parse((await handler(http('PUT', on))).body).remaining, 0);
    await handler(http('DELETE'));

    const refused = await handler(http('PUT', on));
    assert.strictEqual(refused.statusCode, 429);
    assert.strictEqual(JSON.parse(refused.body).code, 'ChaosLimitExceeded');
    assert.deepStrictEqual(JSON.parse(ssm.value), { faults: [] }, 'recusado não grava a config');
    // Dia de cota de 2026-10-04 (12:00 de Brasília em diante)
    assert.strictEqual(db.items.get('quota_chaos_2026-10-04').activations, 2);

    const status = JSON.parse((await handler(http('GET'))).body);
    assert.deepStrictEqual([status.limit, status.used, status.remaining], [2, 2, 0]);
  });

  it('sem limite (local-server): não lê nem grava contador', async () => {
    const db = { getItem: async () => { throw new Error('não deveria ler'); }, updateItem: async () => { throw new Error('não deveria gravar'); } };
    const handler = handlerWith(fakeSsm(undefined), { limit: 0, db });
    const put = await handler(http('PUT', { expiresAt: new Date(NOW + 60000).toISOString(), faults: [{ service: 'stock', type: 'crash' }] }));
    assert.strictEqual(put.statusCode, 200);
    assert.strictEqual(JSON.parse(put.body).limit, undefined);
  });
});

describe('GET/POST /reset', () => {
  // 2026-10-06 13:00 em Brasília: o dia de cota começou às 12:00 (2026-10-06)
  const NOW = Date.parse('2026-10-06T16:00:00Z');
  const http = method => ({ requestContext: { http: { method, path: '/reset' } }, rawPath: '/reset', headers: {} });

  // Tabelas em memória com a mesma interface de src/common/database.mjs.
  // `onScan`: chamado a cada página (para avançar o relógio nos testes de tempo)
  function fakeDb(initial = {}, { onScan = () => {} } = {}) {
    const tables = Object.fromEntries(['products', 'orders', 'payments', 'stockreservations', 'inventory', 'sagas']
      .map(name => [name, new Map((initial[name] || []).map(item => [item.id, { ...item }]))]));
    return {
      tables,
      async getItem(table, { id }) { return tables[table].get(id); },
      async scanPage(table, { limit, startKey }) {
        onScan(table);
        const ids = [...tables[table].keys()].sort();
        const from = startKey ? ids.findIndex(id => id > startKey.id) : 0;
        const page = from < 0 ? [] : ids.slice(from, from + limit);
        const last = page.at(-1);
        return { items: page.map(id => tables[table].get(id)), lastKey: from + limit < ids.length ? { id: last } : undefined };
      },
      async batchDelete(table, keys) { for (const { id } of keys) tables[table].delete(id); },
      async putItem(table, item) { tables[table].set(item.id, item); },
      async updateItem(table, { id }, expression, values, { conditionExpression } = {}) {
        const item = tables[table].get(id) || { id };
        if (expression.startsWith('REMOVE')) {
          delete item.unfinished;
          delete item.continuations;
          tables[table].set(id, item);
          return {};
        }
        if (expression.startsWith('ADD continuations')) {
          if (item.unfinished !== true || (item.continuations || 0) >= values[':max']) {
            throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
          }
          item.continuations = (item.continuations || 0) + values[':one'];
          return { ...item };
        }
        if (conditionExpression && item.resets >= values[':limit']) {
          throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
        }
        item.resets = (item.resets || 0) + values[':one'];
        item.expiresAt = values[':expiresAt'];
        item.unfinished = values[':true'];
        item.continuations = values[':zero'];
        tables[table].set(id, item);
        return { resets: item.resets };
      }
    };
  }

  const handlerWith = (db, env = { RESET_ENABLED: 'true', RESET_DAILY_LIMIT: '2' }, options = {}) =>
    createAPIHandler({ reset: new ResetClient({ env, db, now: () => NOW, ...options }) });

  it('apaga tudo, mantém os contadores de cota e grava os produtos do seed', async () => {
    const db = fakeDb({
      products: [{ id: 'custom' }],
      inventory: [{ id: 'custom', stock: 1 }],
      orders: [{ id: 'o1' }],
      payments: [{ id: 'p1' }],
      stockreservations: [{ id: 'r1' }],
      sagas: [{ id: 's1' }, { id: 'quota_2026-10-06', purchases: 3 }]
    });
    const response = await handlerWith(db)(http('POST'));
    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.deepStrictEqual([body.used, body.remaining, body.products], [1, 1, SEED_PRODUCTS.length]);
    assert.strictEqual(body.deleted.sagas, 1);
    for (const table of ['orders', 'payments', 'stockreservations']) assert.strictEqual(db.tables[table].size, 0, table);
    assert.deepStrictEqual([...db.tables.products.keys()].sort(), SEED_PRODUCTS.map(p => p.id).sort());
    assert.strictEqual(db.tables.inventory.get('apple').stock, 10);
    assert.strictEqual(db.tables.products.get('server').devOnly, undefined);
    assert.ok(db.tables.sagas.has('quota_2026-10-06'));
    assert.strictEqual(db.tables.sagas.get('quota_reset_2026-10-06').resets, 1);
    assert.strictEqual(body.complete, true);
    assert.strictEqual(db.tables.sagas.get('quota_reset_2026-10-06').unfinished, undefined);
  });

  it('sem tempo para acabar: grava o seed, para no meio e o próximo POST continua sem gastar outra vez', async () => {
    let clock = NOW;
    // Cada página do scan leva 1s e o orçamento é 2,5s: as 600 compras (3
    // páginas de 250) não cabem numa chamada só
    const db = fakeDb({
      orders: Array.from({ length: 600 }, (_, i) => ({ id: `o${String(i).padStart(3, '0')}` })),
      payments: [{ id: 'p1' }]
    }, { onScan: () => { clock += 1000; } });
    const handler = createAPIHandler({
      reset: new ResetClient({ env: { RESET_ENABLED: 'true', RESET_DAILY_LIMIT: '1' }, db, now: () => clock, budgetMs: 2500 })
    });

    const first = JSON.parse((await handler(http('POST'))).body);
    assert.deepStrictEqual([first.complete, first.unfinished, first.used], [false, true, 1]);
    assert.ok(db.tables.products.has('apple'), 'o seed vai antes da limpeza');
    assert.ok(db.tables.orders.size > 0);
    assert.strictEqual(JSON.parse((await handler(http('GET'))).body).unfinished, true);

    // Limite de 1 por dia já gasto, mas a continuação não conta
    let response;
    for (let call = 0; call < 10 && !response?.complete; call++) {
      response = JSON.parse((await handler(http('POST'))).body);
    }
    assert.deepStrictEqual([response.used, response.unfinished], [1, false]);
    assert.strictEqual(db.tables.orders.size + db.tables.payments.size, 0);
    assert.strictEqual(db.tables.sagas.get('quota_reset_2026-10-06').resets, 1);

    // Terminado, o próximo reset é um novo e passa do limite
    assert.strictEqual((await handler(http('POST'))).statusCode, 429);
  });

  it('continuar de graça tem teto: esgotado, o próximo POST é um reset novo e gasta a vez', async () => {
    const db = fakeDb({
      sagas: [{ id: 'quota_reset_2026-10-06', resets: 1, unfinished: true, continuations: MAX_RESET_CONTINUATIONS }]
    });
    const handler = handlerWith(db);
    assert.strictEqual(JSON.parse((await handler(http('GET'))).body).unfinished, false);
    const body = JSON.parse((await handler(http('POST'))).body);
    assert.deepStrictEqual([body.complete, body.used], [true, 2]);

    // Limite de 2 já gasto e nada pela metade: recusa
    db.tables.sagas.get('quota_reset_2026-10-06').unfinished = true;
    db.tables.sagas.get('quota_reset_2026-10-06').continuations = MAX_RESET_CONTINUATIONS;
    assert.strictEqual((await handler(http('POST'))).statusCode, 429);
  });

  it('passou do limite do dia: 429 sem apagar nada; GET mostra quantas restam', async () => {
    const db = fakeDb();
    const handler = handlerWith(db);
    await handler(http('POST'));
    await handler(http('POST'));
    db.tables.orders.set('o1', { id: 'o1' });
    const refused = await handler(http('POST'));
    assert.strictEqual(refused.statusCode, 429);
    assert.strictEqual(JSON.parse(refused.body).code, 'ResetLimitExceeded');
    assert.ok(db.tables.orders.has('o1'));
    const status = JSON.parse((await handler(http('GET'))).body);
    assert.deepStrictEqual([status.enabled, status.used, status.remaining, status.unfinished, status.resetsAt],
      [true, 2, 0, false, '2026-10-07T15:00:00.000Z']);
  });

  it('desligado (prod): GET diz enabled false e POST responde 409', async () => {
    const handler = handlerWith(fakeDb(), {});
    assert.deepStrictEqual(JSON.parse((await handler(http('GET'))).body), { enabled: false });
    assert.strictEqual((await handler(http('POST'))).statusCode, 409);
  });
});
