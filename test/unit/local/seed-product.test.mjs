import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeProductUnlessDeleted } from '../../../scripts/lib/seed-product.mjs';

const PRODUCT = { id: 'p1', name: 'Produto', price: 10 };

const canceled = codes => Object.assign(new Error('Transaction cancelled'), {
  name: 'TransactionCanceledException',
  ...(codes && { CancellationReasons: codes.map(Code => ({ Code })) })
});

// db falso: transactWrite falha com `error` (se houver) e getItem devolve `inventory`
function fakeDb({ error, inventory } = {}) {
  const calls = { transactWrite: [], getItem: [] };
  return {
    calls,
    transactWrite: async ops => { calls.transactWrite.push(ops); if (error) throw error; },
    getItem: async (...args) => { calls.getItem.push(args); return inventory; }
  };
}

describe('seed: gravação de produto', () => {
  it('grava o produto condicionado ao inventário não excluído', async () => {
    const db = fakeDb();
    assert.strictEqual(await writeProductUnlessDeleted(db, PRODUCT), 'written');
    const [[check, put]] = db.calls.transactWrite;
    assert.deepStrictEqual(check.ConditionCheck.Key, { id: 'p1' });
    assert.strictEqual(check.ConditionCheck.ConditionExpression, 'attribute_not_exists(deleted)');
    assert.strictEqual(put.Put.Item, PRODUCT);
    assert.strictEqual(put.Put.ConditionExpression, 'attribute_not_exists(id)');
  });

  it('inventário excluído: não recria o produto', async () => {
    const db = fakeDb({ error: canceled(['ConditionalCheckFailed', 'None']) });
    assert.strictEqual(await writeProductUnlessDeleted(db, PRODUCT), 'deleted');
    assert.strictEqual(db.calls.getItem.length, 0);
  });

  it('produto já existente', async () => {
    const db = fakeDb({ error: canceled(['None', 'ConditionalCheckFailed']) });
    assert.strictEqual(await writeProductUnlessDeleted(db, PRODUCT), 'exists');
  });

  it('sem os motivos do cancelamento, consulta o inventário', async () => {
    const deleted = fakeDb({ error: canceled(), inventory: { id: 'p1', deleted: true } });
    assert.strictEqual(await writeProductUnlessDeleted(deleted, PRODUCT), 'deleted');
    assert.deepStrictEqual(deleted.calls.getItem, [['inventory', { id: 'p1' }, { consistentRead: true }]]);

    const live = fakeDb({ error: canceled(), inventory: { id: 'p1', stock: 3 } });
    assert.strictEqual(await writeProductUnlessDeleted(live, PRODUCT), 'exists');
  });

  it('conflito ou outro erro: repassa em vez de concluir', async () => {
    const conflict = canceled(['TransactionConflict', 'None']);
    await assert.rejects(writeProductUnlessDeleted(fakeDb({ error: conflict }), PRODUCT), conflict);

    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    await assert.rejects(writeProductUnlessDeleted(fakeDb({ error: throttled }), PRODUCT), throttled);
  });
});
