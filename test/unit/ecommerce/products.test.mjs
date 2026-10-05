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

describe('ProductSDK.deleteProduct', () => {
  const PRODUCT = { id: 'p1', name: 'Teclado', price: 10 };

  function setup({ publishFails = false, exists = true } = {}) {
    const calls = { deleted: [], restored: [], published: [] };
    const db = {
      // DynamoDB: condição falha se não existe; ALL_OLD devolve o item excluído
      deleteItem: async (table, key, options) => {
        calls.deleted.push({ key, options });
        if (!exists) throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
        return { ...PRODUCT };
      },
      putItemIfNotExists: async (table, item) => { calls.restored.push(item); return true; }
    };
    const bus = {
      publish: async (event, options) => {
        calls.published.push({ type: event.DetailType, options });
        if (publishFails) throw new Error('PutEvents failed');
      }
    };
    return { calls, sdk: new ProductSDK(bus, db) };
  }
  let ProductSDK;

  it('exclui e publica ProductDeleted como evento obrigatório', async () => {
    ProductSDK = await loadProductSDK();
    const { calls, sdk } = setup();
    assert.deepStrictEqual(await sdk.deleteProduct('p1'), { success: true });
    assert.deepStrictEqual(calls.deleted, [{ key: { id: 'p1' }, options: { conditionExpression: 'attribute_exists(id)', returnValues: 'ALL_OLD' } }]);
    assert.deepStrictEqual(calls.published, [{ type: 'ProductDeleted', options: { required: true } }]);
  });

  // Sem o evento o Stock manteria o inventário de um produto que não existe
  // O item restaurado é o que a exclusão devolveu (ALL_OLD), não uma leitura anterior
  it('falha ao publicar: devolve o produto ao catálogo e relança', async () => {
    ProductSDK = await loadProductSDK();
    const { calls, sdk } = setup({ publishFails: true });
    await assert.rejects(sdk.deleteProduct('p1'), /PutEvents failed/);
    assert.deepStrictEqual(calls.restored, [PRODUCT]);
  });

  it('produto inexistente: NotFound sem publicar', async () => {
    ProductSDK = await loadProductSDK();
    const { calls, sdk } = setup({ exists: false });
    await assert.rejects(sdk.deleteProduct('p1'), /Product not found/);
    assert.deepStrictEqual(calls.published, []);
  });
});

describe('DELETE /products/{id}', () => {
  const event = (method, id) => ({ requestContext: { http: { method } }, rawPath: `/products/${id}`, headers: {} });

  // Rota e controller ligados: id inválido é recusado antes de tocar o banco
  it('chega ao deleteProduct (id longo demais: 400)', async () => {
    const { setupRoutes } = await import('../../../src/ecommerce/products/src/routes/productRoutes.js');
    const { normalizeHttpEvent } = await import('../../../src/common/http-event.mjs');
    const response = await setupRoutes(normalizeHttpEvent(event('DELETE', 'x'.repeat(200))));
    assert.strictEqual(response.statusCode, 400);
    assert.match(JSON.parse(response.body).error, /productId/);
  });

  it('é a única rota de produto além do cadastro que exige admin', async () => {
    const { isAdminRoute } = await import('../../../src/common/auth.mjs');
    assert.ok(isAdminRoute('DELETE', '/products/p1'));
    assert.ok(!isAdminRoute('GET', '/products/p1'));
  });
});
