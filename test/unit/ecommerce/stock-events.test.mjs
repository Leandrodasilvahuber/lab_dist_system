import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isDomainEvent, isActionInvocation, runEventHandler } from '../../../src/common/actions.mjs';
import { EventBus } from '../../../src/common/event-bus.mjs';

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
});
