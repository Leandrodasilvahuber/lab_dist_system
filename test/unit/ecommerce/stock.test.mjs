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
describe('StockSDK: degradação graciosa das leituras', () => {
  // Inventário responde; o índice de reservas ativas está fora do ar
  const db = {
    async getItem() { return { id: 'apple', name: 'Apple', stock: 7 }; },
    async scanPage() { return { items: [{ id: 'apple', name: 'Apple', stock: 7 }] }; },
    async queryItems() { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }
  };

  it('getStock devolve o disponível e marca degraded sem as reservas', async () => {
    const StockSDK = await loadStockSDK();
    const stock = await new StockSDK(null, db).getStock('apple');
    assert.deepStrictEqual(stock, { productId: 'apple', name: 'Apple', available: 7, reserved: null, activeReservations: null, degraded: true });
  });

  it('listStock devolve a página com reserved null e degraded', async () => {
    const StockSDK = await loadStockSDK();
    const page = await new StockSDK(null, db).listStock();
    assert.deepStrictEqual(page.stock, [{ productId: 'apple', name: 'Apple', available: 7, reserved: null }]);
    assert.strictEqual(page.degraded, true);
  });

  it('listStock registra um único error para a página, com os produtos afetados', async t => {
    const StockSDK = await loadStockSDK();
    const lines = [];
    const capture = line => lines.push(JSON.parse(line));
    t.mock.method(console, 'error', capture);
    t.mock.method(console, 'warn', capture);
    t.mock.method(console, 'log', capture);
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    try {
      await new StockSDK(null, {
        ...db,
        async scanPage() { return { items: [{ id: 'apple', stock: 7 }, { id: 'pear', stock: 3 }] }; }
      }).listStock();
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    }
    const unavailable = lines.filter(l => l.event === 'STOCK_RESERVATIONS_UNAVAILABLE');
    assert.strictEqual(unavailable.length, 1);
    assert.strictEqual(unavailable[0].status, 'error');
    assert.deepStrictEqual(unavailable[0].data.productIds, ['apple', 'pear']);
  });

  it('com o índice disponível não marca degraded', async () => {
    const StockSDK = await loadStockSDK();
    const sdk = new StockSDK(null, { ...db, async queryItems() { return [{ quantity: 2 }]; } });
    const stock = await sdk.getStock('apple');
    assert.strictEqual(stock.reserved, 2);
    assert.strictEqual(stock.degraded, undefined);
  });

  it('índice de reservas inexistente (configuração) não degrada: continua sendo erro', async () => {
    const StockSDK = await loadStockSDK();
    const missing = Object.assign(new Error('Requested resource not found'), { name: 'ResourceNotFoundException', $metadata: { httpStatusCode: 400 } });
    const sdk = new StockSDK(null, { ...db, async queryItems() { throw missing; } });
    await assert.rejects(sdk.getStock('apple'), error => error === missing);
  });

  it('consulta as reservas sem o retry do SDK (leitura que degrada)', async () => {
    const StockSDK = await loadStockSDK();
    let options;
    const sdk = new StockSDK(null, { ...db, async queryItems(table, params, opts) { options = opts; return []; } });
    await sdk.getStock('apple');
    assert.deepStrictEqual(options, { retry: false });
  });

  it('bug de código na consulta às reservas não degrada: continua sendo erro', async () => {
    const StockSDK = await loadStockSDK();
    const sdk = new StockSDK(null, { ...db, async queryItems() { throw new TypeError('x is not a function'); } });
    await assert.rejects(sdk.getStock('apple'), TypeError);
  });
});

describe('StockSDK.adjustStock', () => {
  it('grava sem o retry do SDK: a soma do delta não é idempotente', async () => {
    const StockSDK = await loadStockSDK();
    let options;
    const db = { async updateItem(table, key, expression, values, opts) { options = opts; return { stock: 12 }; } };
    const result = await new StockSDK(null, db).adjustStock('apple', 2);
    assert.strictEqual(options.retry, false);
    assert.deepStrictEqual(result, { productId: 'apple', previousStock: 10, stock: 12 });
  });

  // Inventário em memória que respeita só a condição attribute_exists(id) da 1ª escrita
  function inventoryDb(initial) {
    const state = { item: initial, writes: [], reads: 0 };
    state.db = {
      async getItem() { state.reads++; return state.item; },
      async updateItem(table, key, expression, values, options) {
        if (options.conditionExpression.startsWith('attribute_exists(id)') && !state.item) {
          throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
        }
        state.writes.push(values);
        state.item = { id: key.id, stock: (state.item?.stock || 0) + values[':delta'], name: state.item?.name ?? values[':name'] };
        return { stock: state.item.stock };
      }
    };
    return state;
  }

  it('não cria inventário de produto que não existe no catálogo', async () => {
    const StockSDK = await loadStockSDK();
    const { NotFoundError } = await import('../../../src/common/errors.mjs');
    const state = inventoryDb(undefined);
    const productClient = { async getProduct() { throw new NotFoundError('Product not found'); } };
    await assert.rejects(new StockSDK(null, state.db, { productClient }).adjustStock('typo', 2), NotFoundError);
    assert.strictEqual(state.writes.length, 0);
  });

  it('cria o inventário de produto existente com o nome do catálogo', async () => {
    const StockSDK = await loadStockSDK();
    const state = inventoryDb(undefined);
    const productClient = { async getProduct(id) { return { id, name: 'Apple' }; } };
    const result = await new StockSDK(null, state.db, { productClient }).adjustStock('apple', 2);
    assert.strictEqual(result.stock, 2);
    assert.strictEqual(state.writes[0][':name'], 'Apple');
  });

  it('inventário existente: uma escrita, sem leitura nem consulta ao catálogo', async () => {
    const StockSDK = await loadStockSDK();
    let calls = 0;
    const productClient = { async getProduct() { calls++; return {}; } };
    const state = inventoryDb({ id: 'apple', stock: 5 });
    const sdk = new StockSDK(null, state.db, { productClient });
    assert.strictEqual((await sdk.adjustStock('apple', 2)).stock, 7);
    assert.strictEqual((await sdk.adjustStock('apple', -1)).stock, 6);
    assert.deepStrictEqual([calls, state.reads, state.writes.length], [0, 0, 2]);
  });
});
