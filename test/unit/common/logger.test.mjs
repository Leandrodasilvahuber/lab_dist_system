import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { log } from '../../../src/common/logger.mjs';

describe('log', () => {
  const original = process.env.LOG_LEVEL;
  afterEach(() => {
    process.env.LOG_LEVEL = original;
    mock.restoreAll();
  });

  function capture(level, entry) {
    process.env.LOG_LEVEL = level;
    const out = mock.method(console, 'log', () => {});
    const err = mock.method(console, 'error', () => {});
    log(entry);
    return { out: out.mock.calls.map(c => JSON.parse(c.arguments[0])), err: err.mock.calls.map(c => JSON.parse(c.arguments[0])) };
  }

  it('escreve uma linha JSON com a mensagem do erro', () => {
    const { err } = capture('info', { event: 'X', status: 'error', error: new Error('boom') });
    assert.strictEqual(err.length, 1);
    assert.strictEqual(err[0].error, 'boom');
  });

  it('LOG_LEVEL=error omite info e mantém erros', () => {
    assert.strictEqual(capture('error', { event: 'X', status: 'info' }).out.length, 0);
    assert.strictEqual(capture('error', { event: 'X', status: 'error' }).err.length, 1);
  });

  it('LOG_LEVEL=silent omite tudo', () => {
    const { out, err } = capture('silent', { event: 'X', status: 'error', error: new Error('boom') });
    assert.strictEqual(out.length + err.length, 0);
  });

  it('LOG_LEVEL=debug inclui info', () => {
    assert.strictEqual(capture('debug', { event: 'X', status: 'info' }).out.length, 1);
  });
});
