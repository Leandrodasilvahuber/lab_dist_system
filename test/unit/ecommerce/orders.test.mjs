import { describe, it } from 'node:test';
import assert from 'node:assert';

// Importação dinâmica para evitar problemas de dependências complexas
async function loadOrderSDK() {
  const { default: OrderSDK } = await import('../../../src/common/sdks/OrderSDK.js');
  return OrderSDK;
}

describe('OrderSDK', () => {
  it('should export OrderSDK class', async () => {
    const OrderSDK = await loadOrderSDK();
    assert.ok(OrderSDK);
    assert.strictEqual(typeof OrderSDK, 'function');
  });

  it('should create OrderSDK instance', async () => {
    const OrderSDK = await loadOrderSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new OrderSDK(dbClient, eventBridgeClient);
    assert.ok(sdk);
    assert.strictEqual(sdk.constructor, OrderSDK);
  });

  it('should have createOrder method on instance', async () => {
    const OrderSDK = await loadOrderSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new OrderSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.createOrder, 'function');
  });

  it('should have getOrder method on instance', async () => {
    const OrderSDK = await loadOrderSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new OrderSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.getOrder, 'function');
  });

  it('should have cancelOrder method on instance', async () => {
    const OrderSDK = await loadOrderSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new OrderSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.cancelOrder, 'function');
  });
});

describe('OrderSDK.listOrders', () => {
  it('lê uma página por vez, esconde os voided e devolve o nextToken', async () => {
    const OrderSDK = await loadOrderSDK();
    const pages = [];
    const db = {
      scanPage: async (table, options) => {
        pages.push([table, options]);
        return { items: [{ id: 'o1', status: 'pending' }, { id: 'o2', status: 'voided' }], lastKey: { id: 'o2' } };
      },
      scanItems: async () => assert.fail('não deveria varrer a tabela inteira')
    };
    const result = await new OrderSDK(null, db).listOrders({}, { limit: 2 });

    assert.deepStrictEqual(pages, [['orders', { limit: 2, startKey: undefined }]]);
    assert.deepStrictEqual(result.orders.map(o => o.id), ['o1']);
    assert.ok(result.nextToken);
  });
});
