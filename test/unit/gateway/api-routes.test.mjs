import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AlarmsClient } from '../../../src/layers/api-gateway-layer/src/services/AlarmsClient.js';
import { createAPIHandler } from '../../../src/layers/api-gateway-layer/src/routes/apiRoutes.js';
import { LogsClient } from '../../../src/layers/api-gateway-layer/src/services/LogsClient.js';

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

  it('LogsClient filtra warn/error no log group e devolve as linhas parseadas, mais recentes primeiro', async () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    const client = fakeCloudWatch({ events: [
      { message: JSON.stringify({ timestamp: '2026-10-04T11:00:00Z', event: 'A', status: 'warn' }) },
      { message: 'START RequestId: abc' },
      { message: `${JSON.stringify({ timestamp: '2026-10-04T11:30:00Z', event: 'B', status: 'error' })}\n` }
    ] });
    const logs = await new LogsClient({ logGroupName: '/aws/lambda/dev-ecommerce', client }).listLogs({ levels: ['warn', 'error'], hours: 2 }, now);

    assert.strictEqual(client.sent[0].logGroupName, '/aws/lambda/dev-ecommerce');
    assert.strictEqual(client.sent[0].filterPattern, '{ ($.status = "warn") || ($.status = "error") }');
    assert.strictEqual(client.sent[0].startTime, now - 2 * 3600 * 1000);
    assert.deepStrictEqual(logs.map(l => l.event), ['B', 'A']);
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

  it('LogsClient lê as 5 páginas quando elas respondem rápido', async () => {
    let clock = 0;
    let calls = 0;
    const client = { async send() { calls += 1; clock += 300; return { events: [], nextToken: 'more' }; } };
    await new LogsClient({ logGroupName: 'g', client, clock: () => clock }).listLogs({ levels: ['error'], hours: 1 });
    assert.strictEqual(calls, 5);
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
});
