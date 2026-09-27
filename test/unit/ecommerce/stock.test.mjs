import { describe, it } from 'node:test';
import assert from 'node:assert';

// Importação dinâmica para evitar problemas de dependências complexas
async function loadStockSDK() {
  const { default: StockSDK } = await import('../../../src/common/sdks/StockSDK.js');
  return StockSDK;
}

describe('StockSDK', () => {
  it('should export StockSDK class', async () => {
    const StockSDK = await loadStockSDK();
    assert.ok(StockSDK);
    assert.strictEqual(typeof StockSDK, 'function');
  });

  it('should create StockSDK instance', async () => {
    const StockSDK = await loadStockSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new StockSDK(dbClient, eventBridgeClient);
    assert.ok(sdk);
    assert.strictEqual(sdk.constructor, StockSDK);
  });

  it('should have getStock method on instance', async () => {
    const StockSDK = await loadStockSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new StockSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.getStock, 'function');
  });

  it('should have reserveStock method on instance', async () => {
    const StockSDK = await loadStockSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new StockSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.reserveStock, 'function');
  });

  it('should have releaseStock method on instance', async () => {
    const StockSDK = await loadStockSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new StockSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.releaseStock, 'function');
  });

  it('should have listStock method on instance', async () => {
    const StockSDK = await loadStockSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new StockSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.listStock, 'function');
  });
});