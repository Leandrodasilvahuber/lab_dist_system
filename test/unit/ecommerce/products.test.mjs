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
describe('preço do produto', () => {
  it('POST /products recusa preço zero ou negativo (não seria comprável)', async () => {
    const { ProductController } = await import('../../../src/ecommerce/products/src/controllers/ProductController.js');
    for (const price of [0, '0', -1, '0.00']) {
      const response = await ProductController.createProduct({ body: JSON.stringify({ name: 'Grátis', price, stock: 1 }) });
      assert.strictEqual(response.statusCode, 400, `price ${JSON.stringify(price)}`);
      assert.match(JSON.parse(response.body).error, /price must be a positive number/);
    }
  });

  it('updateProduct recusa preço zero', async () => {
    const ProductSDK = await loadProductSDK();
    const sdk = new ProductSDK(null, { updateItem: async () => assert.fail('não deveria gravar') });
    await assert.rejects(sdk.updateProduct('p1', { price: 0 }), /price must be a positive number/);
  });
});
