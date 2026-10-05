import { describe, it } from 'node:test';
import assert from 'node:assert';
import { aggregate, createEmfAgent } from '../../../scripts/lib/emf-agent.mjs';
import { emfFields } from '../../../src/common/emf.mjs';

const START = Date.parse('2026-10-04T12:00:00Z');
const metricLine = (timestamp, extra = {}) => JSON.stringify({
  timestamp: new Date(timestamp).toISOString(), event: 'ACTION_REJECTED', status: 'warn', correlationId: 'c1', ...extra,
  ...emfFields([{ metrics: { BusinessErrors: { value: 1 } }, dimensions: { ErrorType: 'PaymentDeclined' }, dimensionSets: [[], ['ErrorType']] }], timestamp)
});

function fakeAws(events) {
  const put = [];
  const filters = [];
  return {
    put,
    filters,
    events,
    cloudwatch: { async send(command) { put.push(command.input); } },
    logs: {
      async send(command) {
        if (command.constructor.name === 'DescribeLogGroupsCommand') return { logGroups: [{ logGroupName: '/aws/lambda/local-PaymentFunction' }] };
        filters.push(command.input);
        return { events: events.filter(e => e.timestamp >= command.input.startTime) };
      }
    }
  };
}

describe('agente EMF local', () => {
  it('publica as métricas das linhas novas das Lambdas e passa toda linha ao buffer', async () => {
    const aws = fakeAws([
      // Antes do agente subir: só vai para o buffer (não conta de novo a cada reinício)
      { eventId: '1', timestamp: START - 1000, message: `2026-10-04T11:59:59.000Z\treq\tINFO\t${metricLine(START - 1000)}` },
      { eventId: '2', timestamp: START + 1000, message: metricLine(START + 1000) },
      { eventId: '3', timestamp: START + 1000, message: 'START RequestId: abc' }
    ]);
    const seen = [];
    const agent = createEmfAgent({ cloudwatch: aws.cloudwatch, logs: aws.logs, onEntry: e => seen.push(e), now: () => START });

    await agent.poll();
    await agent.flush();
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(aws.put.length, 1);
    assert.strictEqual(aws.put[0].Namespace, 'Ecommerce/local');
    // Total + por ErrorType
    assert.deepStrictEqual(aws.put[0].MetricData.map(d => d.Dimensions), [[], [{ Name: 'ErrorType', Value: 'PaymentDeclined' }]]);
    assert.strictEqual(aws.filters[0].startTime, START - 60 * 60 * 1000);

    // 2ª leitura continua do último horário e não repete a linha do mesmo milissegundo
    aws.events.push({ eventId: '4', timestamp: START + 2000, message: metricLine(START + 2000) });
    await agent.poll();
    await agent.flush();
    assert.strictEqual(aws.filters[1].startTime, START + 1000);
    assert.strictEqual(seen.length, 3);
    assert.strictEqual(aws.put.length, 2);
  });

  it('capture publica as linhas do próprio processo; LocalStack fora não derruba nada', async () => {
    const cloudwatch = { async send() { throw new Error('ECONNREFUSED'); } };
    const logs = { async send() { throw new Error('ECONNREFUSED'); } };
    const agent = createEmfAgent({ cloudwatch, logs, now: () => START });
    const warn = console.warn;
    const warnings = [];
    console.warn = message => warnings.push(message);
    try {
      agent.capture(JSON.parse(metricLine(START)));
      await agent.poll();
      await agent.flush();
    } finally {
      console.warn = warn;
    }
    assert.strictEqual(warnings.length, 1);
  });
});

describe('aggregate (um ponto por série e minuto)', () => {
  const datum = (MetricName, Value, at, Dimensions = []) =>
    ({ Namespace: 'Ecommerce/local', MetricName, Unit: 'Milliseconds', Dimensions, Timestamp: new Date(at), Value });

  it('junta o mesmo minuto em StatisticValues e separa minuto e dimensão', () => {
    const dims = [{ Name: 'Action', Value: 'reserveStock' }];
    const result = aggregate([
      datum('ActionDuration', 100, START + 1000, dims),
      datum('ActionDuration', 300, START + 59000, dims),
      datum('ActionDuration', 200, START + 30000, dims),
      datum('ActionDuration', 50, START + 61000, dims),
      datum('ActionDuration', 70, START + 2000)
    ]);
    assert.strictEqual(result.length, 3);
    assert.deepStrictEqual(result[0].StatisticValues, { SampleCount: 3, Sum: 600, Minimum: 100, Maximum: 300 });
    assert.strictEqual(result[0].Timestamp.getTime(), START);
    assert.deepStrictEqual(result[1].StatisticValues, { SampleCount: 1, Sum: 50, Minimum: 50, Maximum: 50 });
    assert.deepStrictEqual(result[2].Dimensions, []);
  });

  it('uma rajada de mil linhas no mesmo minuto vira um ponto por série', async () => {
    const aws = fakeAws([]);
    const agent = createEmfAgent({ cloudwatch: aws.cloudwatch, logs: aws.logs, now: () => START });
    for (let i = 0; i < 1000; i++) agent.capture(JSON.parse(metricLine(START + i)));
    await agent.flush();
    const data = aws.put[0].MetricData;
    // Total + por ErrorType
    assert.strictEqual(data.length, 2);
    assert.deepStrictEqual(data.map(d => d.StatisticValues.Sum), [1000, 1000]);
    assert.ok(data.every(d => d.Value === undefined));
  });
});
