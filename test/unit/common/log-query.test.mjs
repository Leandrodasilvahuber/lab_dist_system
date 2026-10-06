import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseLogQuery, parseLogLine, createLogBuffer, isTraceId, withoutMetrics } from '../../../src/common/log-query.mjs';

const line = (status, timestamp, event = 'X', extra = {}) => JSON.stringify({ timestamp, event, status, ...extra });
const NOW = Date.parse('2026-10-04T12:00:00Z');

describe('log-query', () => {
  it('parseLogQuery: level=error filtra só error; padrão 24 h, períodos fixos até 14 dias', () => {
    assert.deepStrictEqual(parseLogQuery({}), { levels: ['warn', 'error'], hours: 24 });
    assert.deepStrictEqual(parseLogQuery({ level: 'error', hours: '1' }), { levels: ['error'], hours: 1 });
    assert.strictEqual(parseLogQuery({ hours: '99999' }).hours, 336);
    // Só os períodos da lista (chave do cache do LogsClient)
    assert.strictEqual(parseLogQuery({ hours: '5' }).hours, 1);
    assert.strictEqual(parseLogQuery({ hours: '30' }).hours, 24);
  });

  it('parseLogLine ignora o que não é linha do logger', () => {
    assert.strictEqual(parseLogLine('GET /health -> 200'), null);
    assert.strictEqual(parseLogLine('{quebrado'), null);
    assert.strictEqual(parseLogLine(line('warn', '2026-10-04T11:00:00Z')).status, 'warn');
  });

  it('parseLogLine aceita o prefixo de texto do runtime da Lambda', () => {
    const entry = parseLogLine(`2026-10-04T11:00:00.000Z\tabc-123\tINFO\t${line('info', '2026-10-04T11:00:00Z', 'A')}`);
    assert.strictEqual(entry.event, 'A');
  });

  it('isTraceId aceita ids do sistema e recusa o que quebraria o filter pattern', () => {
    assert.ok(isTraceId('saga_0f8e2a6c-1b2d-4c3e-9f00-123456789abc'));
    assert.ok(isTraceId('order_saga_abc.1:2-3'));
    assert.ok(!isTraceId('x" || $.status = "error'));
    assert.ok(!isTraceId(''));
    assert.ok(!isTraceId('a'.repeat(129)));
  });

  it('withoutMetrics tira o bloco _aws e os valores/dimensões EMF da raiz', () => {
    const entry = {
      event: 'X', status: 'warn', errorType: 'NotFound', ErrorType: 'NotFound', BusinessErrors: 1,
      _aws: { CloudWatchMetrics: [{ Dimensions: [[], ['ErrorType']], Metrics: [{ Name: 'BusinessErrors' }] }] }
    };
    assert.deepStrictEqual(withoutMetrics(entry), { event: 'X', status: 'warn', errorType: 'NotFound' });
  });

  it('trace: todas as linhas com o correlationId, em ordem, sem as linhas só de métrica', () => {
    const buffer = createLogBuffer(10);
    buffer.capture(line('info', '2026-10-04T11:00:02Z', 'B', { correlationId: 'c1' }));
    buffer.capture(line('warn', '2026-10-04T11:00:03Z', 'C', { correlationId: 'c1' }));
    buffer.capture(line('info', '2026-10-04T11:00:01Z', 'A', { correlationId: 'c1' }));
    buffer.capture(line('info', '2026-10-04T11:00:01Z', 'OUTRA', { correlationId: 'c2' }));
    buffer.capture(JSON.stringify({ timestamp: '2026-10-04T11:00:04Z', event: 'METRICA', correlationId: 'c1', ActionCount: 1 }));

    assert.deepStrictEqual(buffer.trace('c1').map(e => e.event), ['A', 'B', 'C']);
    // info sem correlationId não interessa a nenhuma aba
    buffer.capture(line('info', '2026-10-04T11:00:05Z', 'SEM_ID'));
    assert.deepStrictEqual(buffer.query({}, NOW).map(e => e.event), ['C']);
  });

  it('buffer guarda só warn/error, filtra por nível e período, mais recentes primeiro', () => {
    const buffer = createLogBuffer(10);
    buffer.capture(line('info', '2026-10-04T11:59:00Z'));
    buffer.capture(line('warn', '2026-10-04T11:00:00Z', 'A'));
    buffer.capture(line('error', '2026-10-04T11:30:00Z', 'B'));
    buffer.capture(line('error', '2026-10-03T00:00:00Z', 'ANTIGO'));

    assert.deepStrictEqual(buffer.query({}, NOW).map(e => e.event), ['B', 'A']);
    assert.deepStrictEqual(buffer.query({ level: 'error' }, NOW).map(e => e.event), ['B']);
  });

  it('buffer descarta as linhas mais antigas ao encher', () => {
    const buffer = createLogBuffer(2);
    for (const minute of ['01', '02', '03']) buffer.capture(line('warn', `2026-10-04T11:${minute}:00Z`, minute));
    assert.deepStrictEqual(buffer.query({}, NOW).map(e => e.event), ['03', '02']);
  });
});
