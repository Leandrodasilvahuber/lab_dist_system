import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AlarmsClient } from '../../../src/layers/api-gateway-layer/src/services/AlarmsClient.js';
import { authConfig, createAPIHandler } from '../../../src/layers/api-gateway-layer/src/routes/apiRoutes.js';
import { LogsClient } from '../../../src/layers/api-gateway-layer/src/services/LogsClient.js';
import { ChaosClient } from '../../../src/layers/api-gateway-layer/src/services/ChaosClient.js';

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

  function handlerWith(ssm, { enabled = true } = {}) {
    const chaos = new ChaosClient({ parameterName: '/test/ecommerce/chaos', enabled, client: ssm, now: () => NOW });
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
});
