import { describe, it } from 'node:test';
import assert from 'node:assert';

// Importação dinâmica para evitar problemas de dependências complexas
async function loadProductSDK() {
  const { default: ProductSDK } = await import('../../../src/common/sdks/ProductSDK.js');
  return ProductSDK;
}

describe('ProductSDK', () => {
  it('should export ProductSDK class', async () => {
    const ProductSDK = await loadProductSDK();
    assert.ok(ProductSDK);
    assert.strictEqual(typeof ProductSDK, 'function');
  });

  it('should create ProductSDK instance', async () => {
    const ProductSDK = await loadProductSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new ProductSDK(dbClient, eventBridgeClient);
    assert.ok(sdk);
    assert.strictEqual(sdk.constructor, ProductSDK);
  });

  it('should have createProduct method on instance', async () => {
    const ProductSDK = await loadProductSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new ProductSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.createProduct, 'function');
  });

  it('should have getProduct method on instance', async () => {
    const ProductSDK = await loadProductSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new ProductSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.getProduct, 'function');
  });

  it('should have updateProduct method on instance', async () => {
    const ProductSDK = await loadProductSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new ProductSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.updateProduct, 'function');
  });

  it('should have listProducts method on instance', async () => {
    const ProductSDK = await loadProductSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new ProductSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.listProducts, 'function');
  });

  it('should have deleteProduct method on instance', async () => {
    const ProductSDK = await loadProductSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new ProductSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.deleteProduct, 'function');
  });
});