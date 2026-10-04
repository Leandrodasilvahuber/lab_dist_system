import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { CircuitBreaker } from '../../../src/common/circuit-breaker.mjs';
import { DependencyUnavailableError, NotFoundError } from '../../../src/common/errors.mjs';

const fail = () => Promise.reject(new Error('down'));
const ok = () => Promise.resolve('ok');

describe('CircuitBreaker', () => {
  let clock;
  let breaker;
  beforeEach(() => {
    clock = 0;
    breaker = new CircuitBreaker({ name: 'dep', failureThreshold: 3, resetTimeoutMs: 10000, now: () => clock });
  });

  async function failTimes(n) {
    for (let i = 0; i < n; i++) await assert.rejects(breaker.call(fail), /down/);
  }

  it('abre depois de failureThreshold falhas seguidas', async () => {
    await failTimes(2);
    assert.strictEqual(breaker.state, 'closed');
    await failTimes(1);
    assert.strictEqual(breaker.state, 'open');
  });

  it('isFailure decide o que conta como falha', async () => {
    breaker = new CircuitBreaker({ name: 'dep', failureThreshold: 1, isFailure: error => error instanceof DependencyUnavailableError });
    await assert.rejects(breaker.call(fail), /down/);
    assert.strictEqual(breaker.state, 'closed');
    await assert.rejects(breaker.call(() => Promise.reject(new DependencyUnavailableError('x'))), DependencyUnavailableError);
    assert.strictEqual(breaker.state, 'open');
  });

  it('um sucesso zera a contagem de falhas', async () => {
    await failTimes(2);
    await breaker.call(ok);
    await failTimes(2);
    assert.strictEqual(breaker.state, 'closed');
  });

  it('aberto: falha na hora com 503 e Retry-After do tempo restante, sem chamar a dependência', async () => {
    await failTimes(3);
    clock = 4000;
    let called = false;
    await assert.rejects(breaker.call(async () => { called = true; }), error =>
      error instanceof DependencyUnavailableError && error.statusCode === 503 && error.retryAfterSeconds === 6);
    assert.strictEqual(called, false);
  });

  it('meio-aberto: sucesso da chamada de teste fecha o circuito', async () => {
    await failTimes(3);
    clock = 10000;
    assert.strictEqual(await breaker.call(ok), 'ok');
    assert.strictEqual(breaker.state, 'closed');
  });

  it('meio-aberto: falha da chamada de teste reabre o circuito', async () => {
    await failTimes(3);
    clock = 10000;
    await assert.rejects(breaker.call(fail), /down/);
    assert.strictEqual(breaker.state, 'open');
    await assert.rejects(breaker.call(ok), DependencyUnavailableError);
  });

  it('meio-aberto: só uma chamada de teste por vez', async () => {
    await failTimes(3);
    clock = 10000;
    let release;
    const trial = breaker.call(() => new Promise(resolve => { release = resolve; }));
    await assert.rejects(breaker.call(ok), DependencyUnavailableError);
    release('ok');
    assert.strictEqual(await trial, 'ok');
    assert.strictEqual(breaker.state, 'closed');
  });

  it('aberto: chamada que começou antes da abertura e termina bem não fecha o circuito', async () => {
    let release;
    const slow = breaker.call(() => new Promise(resolve => { release = resolve; }));
    await failTimes(3);
    assert.strictEqual(breaker.state, 'open');
    release('ok');
    assert.strictEqual(await slow, 'ok');
    assert.strictEqual(breaker.state, 'open');
  });

  it('meio-aberto: só o resultado da chamada de teste muda o circuito', async () => {
    let rejectSlow;
    const slow = breaker.call(() => new Promise((_, reject) => { rejectSlow = reject; }));
    await failTimes(3);
    clock = 10000;
    let release;
    const trial = breaker.call(() => new Promise(resolve => { release = resolve; }));
    rejectSlow(new Error('down'));
    await assert.rejects(slow, /down/);
    assert.strictEqual(breaker.state, 'half-open');
    release('ok');
    await trial;
    assert.strictEqual(breaker.state, 'closed');
  });

  it('erro de negócio não conta como falha', async () => {
    for (let i = 0; i < 5; i++) {
      await assert.rejects(breaker.call(() => Promise.reject(new NotFoundError('x'))), NotFoundError);
    }
    assert.strictEqual(breaker.state, 'closed');
  });

  it('abrir o circuito gera a métrica CircuitOpened (com alarme), não BusinessErrors', async t => {
    const lines = [];
    const capture = line => lines.push(JSON.parse(line));
    t.mock.method(console, 'error', capture);
    t.mock.method(console, 'warn', capture);
    t.mock.method(console, 'log', capture);
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    try {
      await failTimes(3);
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    }

    const opened = lines.find(line => line.event === 'CIRCUIT_STATE_CHANGED');
    assert.strictEqual(opened.status, 'error');
    assert.strictEqual(opened.CircuitOpened, 1);
    assert.strictEqual(opened.Circuit, 'dep');
    assert.strictEqual(opened.error, 'down');
    assert.strictEqual(opened.BusinessErrors, undefined);
  });
});
