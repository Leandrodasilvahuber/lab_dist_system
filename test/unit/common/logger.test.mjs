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

  it('debug só sai com LOG_LEVEL=debug', () => {
    assert.strictEqual(capture('info', { event: 'X', status: 'debug' }).out.length, 0);
    assert.strictEqual(capture('debug', { event: 'X', status: 'debug' }).out[0].status, 'debug');
  });

  it('LOG_LEVEL=debug inclui info', () => {
    assert.strictEqual(capture('debug', { event: 'X', status: 'info' }).out.length, 1);
  });
});

describe('log: métricas EMF', () => {
  const original = process.env.LOG_LEVEL;
  afterEach(() => {
    process.env.LOG_LEVEL = original;
    mock.restoreAll();
  });

  function lines(level, entry) {
    process.env.LOG_LEVEL = level;
    const calls = ['log', 'warn', 'error'].map(m => mock.method(console, m, () => {}));
    log(entry);
    return calls.flatMap(c => c.mock.calls.map(call => JSON.parse(call.arguments[0])));
  }

  it('warn conta em BusinessErrors, total e por ErrorType (nome do erro)', () => {
    const [line] = lines('info', { event: 'X', status: 'warn', error: new ValidationError('inválido') });
    assert.strictEqual(line.BusinessErrors, 1);
    assert.strictEqual(line.ErrorType, 'ValidationError');
    assert.deepStrictEqual(line._aws.CloudWatchMetrics[0].Dimensions, [[], ['ErrorType']]);
    assert.strictEqual(line.UnhandledErrors, undefined);
  });

  it('error conta em UnhandledErrors', () => {
    const [line] = lines('info', { event: 'X', status: 'error', error: new TypeError('boom') });
    assert.strictEqual(line.UnhandledErrors, 1);
    assert.strictEqual(line.ErrorType, 'TypeError');
  });

  it('warn sem objeto de erro usa o status HTTP de data (ou Rejected)', () => {
    assert.strictEqual(lines('info', { event: 'X', status: 'warn', data: { statusCode: 404 } })[0].ErrorType, 'HTTP_404');
    assert.strictEqual(lines('info', { event: 'X', status: 'warn' })[0].ErrorType, 'Rejected');
  });

  it('info sem métricas pedidas não leva _aws; com `metrics`, leva', () => {
    assert.strictEqual(lines('info', { event: 'X', status: 'info' })[0]._aws, undefined);
    const [line] = lines('info', { event: 'X', status: 'info', metrics: { metrics: { ActionCount: { value: 1 } }, dimensions: { Action: 'a' }, dimensionSets: [['Action']] } });
    assert.strictEqual(line.ActionCount, 1);
    assert.strictEqual(line.Action, 'a');
  });

  it('abaixo do LOG_LEVEL sai só uma linha mínima com as métricas (sem status)', () => {
    const [line, ...rest] = lines('error', { event: 'X', correlationId: 'c1', status: 'warn', message: 'some', error: new ValidationError('x') });
    assert.strictEqual(rest.length, 0);
    assert.strictEqual(line.status, undefined);
    assert.strictEqual(line.message, undefined);
    assert.strictEqual(line.correlationId, 'c1');
    assert.strictEqual(line.BusinessErrors, 1);
  });

  it('abaixo do LOG_LEVEL e sem métricas, nada sai; silent nunca escreve', () => {
    assert.strictEqual(lines('error', { event: 'X', status: 'info' }).length, 0);
    assert.strictEqual(lines('silent', { event: 'X', status: 'warn', error: new ValidationError('x') }).length, 0);
  });
});
