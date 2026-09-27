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