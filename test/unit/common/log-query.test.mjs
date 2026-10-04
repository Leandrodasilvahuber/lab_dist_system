import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseLogQuery, parseLogLine, createLogBuffer } from '../../../src/common/log-query.mjs';

const line = (status, timestamp, event = 'X') => JSON.stringify({ timestamp, event, status });
const NOW = Date.parse('2026-10-04T12:00:00Z');

describe('log-query', () => {
  it('parseLogQuery: level=error filtra só error; padrão 24 h, máximo 14 dias', () => {
    assert.deepStrictEqual(parseLogQuery({}), { levels: ['warn', 'error'], hours: 24 });
    assert.deepStrictEqual(parseLogQuery({ level: 'error', hours: '1' }), { levels: ['error'], hours: 1 });
    assert.strictEqual(parseLogQuery({ hours: '99999' }).hours, 336);
  });

  it('parseLogLine ignora o que não é linha do logger', () => {
    assert.strictEqual(parseLogLine('GET /health -> 200'), null);
    assert.strictEqual(parseLogLine('{quebrado'), null);
    assert.strictEqual(parseLogLine(line('warn', '2026-10-04T11:00:00Z')).status, 'warn');
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
