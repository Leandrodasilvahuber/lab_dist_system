import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { runAction, runEventHandler } from '../../../src/common/actions.mjs';
import { NotFoundError } from '../../../src/common/errors.mjs';

describe('runAction: métricas EMF por ação', () => {
  const original = process.env.LOG_LEVEL;
  afterEach(() => {
    process.env.LOG_LEVEL = original;
    mock.restoreAll();
  });

  function capture() {
    process.env.LOG_LEVEL = 'info';
    const calls = ['log', 'warn', 'error'].map(m => mock.method(console, m, () => {}));
    return () => calls.flatMap(c => c.mock.calls.map(call => JSON.parse(call.arguments[0])));
  }

  it('sucesso: ACTION_COMPLETED com ActionCount/ActionDuration e Outcome ok', async () => {
    const lines = capture();
    await runAction({ reserveStock: async () => 'ok' }, { action: 'reserveStock', input: { correlationId: 'c1' } });
    const [line] = lines().filter(l => l.event === 'ACTION_COMPLETED');
    assert.strictEqual(line.ActionCount, 1);
    assert.strictEqual(typeof line.ActionDuration, 'number');
    assert.deepStrictEqual([line.Action, line.Outcome], ['reserveStock', 'ok']);
    assert.deepStrictEqual(line._aws.CloudWatchMetrics[0].Dimensions, [['Action', 'Outcome']]);
  });

  it('erro de negócio: Outcome rejected e BusinessErrors na mesma linha', async () => {
    const lines = capture();
    await assert.rejects(runAction({ confirmOrder: async () => { throw new NotFoundError('x'); } }, { action: 'confirmOrder', input: {} }));
    const [line] = lines().filter(l => l.event === 'ACTION_REJECTED');
    assert.deepStrictEqual([line.status, line.Outcome, line.BusinessErrors, line.ErrorType], ['warn', 'rejected', 1, 'NotFound']);
  });

  it('falha de infraestrutura: Outcome failed e UnhandledErrors', async () => {
    const lines = capture();
    await assert.rejects(runAction({ commit: async () => { throw new Error('timeout'); } }, { action: 'commit', input: {} }));
    const [line] = lines().filter(l => l.event === 'ACTION_FAILED');
    assert.deepStrictEqual([line.Outcome, line.UnhandledErrors], ['failed', 1]);
  });

  it('evento rejeitado: BusinessErrors uma vez só (no DOMAIN_EVENT_REJECTED); a ação conta rejected', async () => {
    const lines = capture();
    const handlers = { 'products/ProductCreated': async () => { throw new NotFoundError('x'); } };
    await runEventHandler(handlers, { source: 'products', 'detail-type': 'ProductCreated', detail: {} });
    const all = lines();
    assert.strictEqual(all.filter(l => l.BusinessErrors).length, 1);
    assert.strictEqual(all.find(l => l.BusinessErrors).event, 'DOMAIN_EVENT_REJECTED');
    const action = all.find(l => l.ActionCount);
    assert.deepStrictEqual([action.status, action.Outcome], [undefined, 'rejected']);
  });
});

describe('runAction: falhas transitórias', () => {
  it('timeout/throttling/conexão caída saem como TransientError (o Retry do workflow repete)', async () => {
    const { TransientError } = await import('../../../src/common/actions.mjs');
    for (const cause of [
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      Object.assign(new Error('slow down'), { name: 'ThrottlingException' })
    ]) {
      await assert.rejects(
        runAction({ step: async () => { throw cause; } }, { action: 'step', input: {} }),
        error => error instanceof TransientError && error.name === 'TransientError' && error.cause === cause
      );
    }
  });

  it('erro de negócio e bug seguem com o próprio nome', async () => {
    await assert.rejects(runAction({ step: async () => { throw new NotFoundError('x'); } }, { action: 'step', input: {} }), NotFoundError);
    await assert.rejects(runAction({ step: async () => { throw new TypeError('bug'); } }, { action: 'step', input: {} }), TypeError);
  });

  it('o workflow repete TransientError em todos os passos', async () => {
    const fs = await import('node:fs');
    const asl = JSON.parse(fs.readFileSync(new URL('../../../src/ecommerce/saga-orchestrator/workflow/saga-workflow.asl.json', import.meta.url), 'utf8'));
    const lambdaTasks = Object.values(asl.States).filter(state => state.Resource === 'arn:aws:states:::lambda:invoke');
    assert.ok(lambdaTasks.length > 0);
    for (const task of lambdaTasks) {
      assert.ok(task.Retry.some(r => r.ErrorEquals.includes('TransientError')));
    }
  });
});
