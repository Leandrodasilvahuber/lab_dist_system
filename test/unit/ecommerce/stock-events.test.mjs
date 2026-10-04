import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { isDomainEvent, isActionInvocation, runEventHandler } from '../../../src/common/actions.mjs';
import { EventBus } from '../../../src/common/event-bus.mjs';
import { ValidationError } from '../../../src/common/errors.mjs';

process.env.LOG_LEVEL = 'silent';

const productCreated = {
  source: 'products',
  'detail-type': 'ProductCreated',
  detail: { productId: 'p1', name: 'Teclado', initialStock: 10 }
};

describe('eventos de domínio', () => {
  it('distingue evento do EventBridge de invocação de ação e de HTTP', () => {
    assert.strictEqual(isDomainEvent(productCreated), true);
    assert.strictEqual(isActionInvocation(productCreated), false);
    assert.strictEqual(isDomainEvent({ action: 'reserveStock', input: {} }), false);
    assert.strictEqual(isDomainEvent({ requestContext: {}, source: 'x', 'detail-type': 'y' }), false);
  });

  it('runEventHandler chama o handler de <source>/<detail-type> com o detail', async () => {
    const received = [];
    const handlers = { 'products/ProductCreated': detail => received.push(detail) };
    await runEventHandler(handlers, productCreated);
    assert.deepStrictEqual(received, [productCreated.detail]);
  });

  it('evento sem handler é ignorado', async () => {
    assert.deepStrictEqual(await runEventHandler({}, { ...productCreated, 'detail-type': 'Other' }), { ignored: true });
  });

  it('erro de negócio no handler fica no log e o evento é confirmado (não vai para a DLQ)', async () => {
    const handlers = { 'products/ProductCreated': () => { throw new ValidationError('initialStock must be a non-negative integer'); } };
    assert.deepStrictEqual(await runEventHandler(handlers, productCreated),
      { rejected: true, reason: 'initialStock must be a non-negative integer' });
  });

  it('evento rejeitado gera uma linha de log só (DOMAIN_EVENT_REJECTED)', async () => {
    const original = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    const warn = mock.method(console, 'warn', () => {});
    try {
      const handlers = { 'products/ProductCreated': () => { throw new ValidationError('inválido'); } };
      await runEventHandler(handlers, productCreated);
      assert.deepStrictEqual(warn.mock.calls.map(c => JSON.parse(c.arguments[0]).event), ['DOMAIN_EVENT_REJECTED']);
    } finally {
      process.env.LOG_LEVEL = original;
      mock.restoreAll();
    }
  });

  it('falha transitória é relançada (a Lambda repete e, no fim, manda para a DLQ)', async () => {
    const handlers = { 'products/ProductCreated': () => { throw new Error('ProvisionedThroughputExceeded'); } };
    await assert.rejects(runEventHandler(handlers, productCreated), /ProvisionedThroughputExceeded/);
  });

  it('EventBus sem EVENT_BUS_NAME entrega aos assinantes locais no formato do EventBridge', async () => {
    const bus = new EventBus({ eventBusName: '' });
    const received = [];
    bus.subscribe('products', 'ProductCreated', event => received.push(event));
    bus.subscribe('products', 'Other', () => { throw new Error('não deveria ser chamado'); });

    await bus.publish({ Source: 'products', DetailType: 'ProductCreated', Detail: productCreated.detail });
    assert.deepStrictEqual(received, [productCreated]);
  });

  it('falha de assinante local não interrompe quem publicou', async () => {
    const bus = new EventBus({ eventBusName: '' });
    bus.subscribe('products', 'ProductCreated', () => { throw new Error('falhou'); });
    await bus.publish({ Source: 'products', DetailType: 'ProductCreated', Detail: {} });
  });

  it('strictLocalDelivery relança a falha do assinante local (reprocessamento da DLQ)', async () => {
    const bus = new EventBus({ eventBusName: '' });
    bus.subscribe('products', 'ProductCreated', () => { throw new Error('falhou'); });
    await bus.publish({ Source: 'products', DetailType: 'ProductCreated', Detail: {} }, { required: true });
    await assert.rejects(
      bus.publish({ Source: 'products', DetailType: 'ProductCreated', Detail: {} }, { strictLocalDelivery: true }),
      /falhou/
    );
  });
});

describe('EventBus com EventBridge', () => {
  const failingClient = { send: async () => { throw new Error('EventBridge indisponível'); } };

  it('evento informativo: falha só é registrada', async () => {
    const bus = new EventBus({ eventBusName: 'bus', client: failingClient });
    await bus.publish({ Source: 'orders', DetailType: 'OrderCreated', Detail: {} });
  });

  it('evento obrigatório: falha é relançada para quem publicou', async () => {
    const bus = new EventBus({ eventBusName: 'bus', client: failingClient });
    await assert.rejects(
      bus.publish({ Source: 'products', DetailType: 'ProductCreated', Detail: {} }, { required: true }),
      /EventBridge indisponível/
    );
  });
});

describe('redact (log das ações)', () => {
  it('oculta campos sensíveis em objetos e arrays aninhados', async () => {
    const { redact } = await import('../../../src/common/actions.mjs');
    assert.deepStrictEqual(
      redact({ orderId: 'o1', cvv: '123', payment: { cardNumber: '4111', amount: 10 }, cards: [{ token: 't' }] }),
      { orderId: 'o1', cvv: '[REDACTED]', payment: { cardNumber: '[REDACTED]', amount: 10 }, cards: [{ token: '[REDACTED]' }] }
    );
  });
});

describe('initializeStock', () => {
  it('recusa initialStock que só vira número por coerção (null, true, "")', async () => {
    const { StockSDK } = await import('../../../src/common/sdks/StockSDK.js');
    const stock = new StockSDK(null, { putItemIfNotExists: async () => assert.fail('não deveria gravar') });
    for (const initialStock of [null, true, '']) {
      await assert.rejects(stock.initializeStock({ productId: 'p1', initialStock }), ValidationError, JSON.stringify(initialStock));
    }
  });

  // Captura as linhas warn do logger durante `fn`
  async function warnings(fn) {
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'warn';
    const warn = mock.method(console, 'warn', () => {});
    try {
      await fn();
      return warn.mock.calls.map(call => JSON.parse(call.arguments[0]).event);
    } finally {
      warn.mock.restore();
      process.env.LOG_LEVEL = previous;
    }
  }

  it('avisa quando o inventário já foi criado por um ajuste e o estoque inicial é descartado', async () => {
    const { StockSDK } = await import('../../../src/common/sdks/StockSDK.js');
    const stock = new StockSDK(null, {
      putItemIfNotExists: async () => false,
      getItem: async () => ({ id: 'p1', stock: 3 })
    });
    const events = await warnings(async () => {
      assert.strictEqual((await stock.initializeStock({ productId: 'p1', initialStock: 10 })).stock, 3);
    });
    assert.deepStrictEqual(events, ['STOCK_INITIAL_IGNORED']);
  });

  it('ProductCreated repetido ou de produto já removido não gera aviso', async () => {
    const { StockSDK } = await import('../../../src/common/sdks/StockSDK.js');
    for (const existing of [{ id: 'p1', stock: 8, initialStock: 10 }, { id: 'p1', stock: 0, deleted: true }]) {
      const stock = new StockSDK(null, { putItemIfNotExists: async () => false, getItem: async () => existing });
      assert.deepStrictEqual(await warnings(() => stock.initializeStock({ productId: 'p1', initialStock: 10 })), []);
    }
  });
});
