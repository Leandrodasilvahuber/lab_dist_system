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
