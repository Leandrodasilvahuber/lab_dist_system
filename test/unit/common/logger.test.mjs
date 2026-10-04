import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { log } from '../../../src/common/logger.mjs';
import { ValidationError } from '../../../src/common/errors.mjs';

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
    const warn = mock.method(console, 'warn', () => {});
    log(entry);
    const parse = m => m.mock.calls.map(c => JSON.parse(c.arguments[0]));
    return { out: parse(out), err: parse(err), warn: parse(warn) };
  }

  it('escreve uma linha JSON com a mensagem do erro', () => {
    const { err } = capture('info', { event: 'X', status: 'error', error: new Error('boom') });
    assert.strictEqual(err.length, 1);
    assert.strictEqual(err[0].error, 'boom');
  });

  it('erro não tratado leva errorType e stack', () => {
    const { err } = capture('info', { event: 'X', status: 'error', error: new TypeError('boom') });
    assert.strictEqual(err[0].errorType, 'TypeError');
    assert.match(err[0].stack, /TypeError: boom/);
  });

  it('erro tratado (warn) leva errorType, sem stack', () => {
    const { warn, err } = capture('info', { event: 'X', status: 'warn', error: new ValidationError('inválido') });
    assert.strictEqual(err.length, 0);
    assert.strictEqual(warn[0].status, 'warn');
    assert.strictEqual(warn[0].errorType, 'ValidationError');
    assert.strictEqual(warn[0].stack, undefined);
  });

  it('LOG_LEVEL=error omite warn', () => {
    assert.strictEqual(capture('error', { event: 'X', status: 'warn' }).warn.length, 0);
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
