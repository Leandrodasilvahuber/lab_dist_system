import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AlarmsClient } from '../../../src/layers/api-gateway-layer/src/services/AlarmsClient.js';
import { createAPIHandler } from '../../../src/layers/api-gateway-layer/src/routes/apiRoutes.js';

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
