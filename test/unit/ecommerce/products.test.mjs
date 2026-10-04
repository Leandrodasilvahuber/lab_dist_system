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

  it('POST /products recusa name e description longos demais (400, não 500 do DynamoDB)', async () => {
    const { ProductController } = await import('../../../src/ecommerce/products/src/controllers/ProductController.js');
    const { MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH } = await import('../../../src/common/validation.mjs');
    const cases = [
      [{ name: 'x'.repeat(MAX_NAME_LENGTH + 1), price: 1 }, /name must have at most/],
      [{ name: 'X', price: 1, description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }, /description must have at most/]
    ];
    for (const [body, error] of cases) {
      const response = await ProductController.createProduct({ body: JSON.stringify(body) });
      assert.strictEqual(response.statusCode, 400);
      assert.match(JSON.parse(response.body).error, error);
    }
  });

  it('updateProduct recusa preço zero', async () => {
    const ProductSDK = await loadProductSDK();
    const sdk = new ProductSDK(null, { updateItem: async () => assert.fail('não deveria gravar') });
    await assert.rejects(sdk.updateProduct('p1', { price: 0 }), /price must be a positive number/);
  });

  it('updateProduct só aceita campos do catálogo, validados como na criação', async () => {
    const ProductSDK = await loadProductSDK();
    const sdk = new ProductSDK(null, { updateItem: async () => assert.fail('não deveria gravar') });
    await assert.rejects(sdk.updateProduct('p1', { id: 'outro' }), /Fields cannot be updated: id/);
    await assert.rejects(sdk.updateProduct('p1', { isAdmin: true, price: 5 }), /Fields cannot be updated: isAdmin/);
    await assert.rejects(sdk.updateProduct('p1', { name: '   ' }), /name must be a non-empty string/);
    await assert.rejects(sdk.updateProduct('p1', { name: 'x'.repeat(201) }), /name must be/);
    await assert.rejects(sdk.updateProduct('p1', { description: 'x'.repeat(2001) }), /description must be/);
  });

  it('updateProduct grava o nome sem espaços e ignora campos undefined', async () => {
    const ProductSDK = await loadProductSDK();
    let call;
    const sdk = new ProductSDK(null, { updateItem: async (...args) => { call = args; return {}; } });
    await sdk.updateProduct('p1', { name: '  Teclado  ', description: undefined });
    const [, , expression, values, options] = call;
    assert.strictEqual(expression, 'SET updatedAt = :updatedAt, #f0 = :f0');
    assert.deepStrictEqual(options.expressionAttributeNames, { '#f0': 'name' });
    assert.strictEqual(values[':f0'], 'Teclado');
  });
});
