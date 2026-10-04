/**
 * Testes de integração dos SDKs contra um DynamoDB real (LocalStack).
 *   npm run localstack:start && npm run test:integration
 * Sem DynamoDB acessível, os testes são pulados.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBClient, DeleteTableCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { ensureTable, logicalName } from '../../scripts/lib/tables.mjs';

const endpoint = process.env.DYNAMODB_ENDPOINT || 'http://localhost:4566';
const prefix = `it-${Date.now()}`;
const TABLES = {
  PRODUCTS_TABLE: `${prefix}-Products`,
  ORDERS_TABLE: `${prefix}-Orders`,
  PAYMENTS_TABLE: `${prefix}-Payments`,
  STOCK_RESERVATIONS_TABLE: `${prefix}-StockReservations`,
  INVENTORY_TABLE: `${prefix}-Inventory`,
  SAGAS_TABLE: `${prefix}-Sagas`
};
Object.assign(process.env, TABLES, {
  DYNAMODB_ENDPOINT: endpoint,
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'test',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  PAYMENT_MAX_AMOUNT: '1000'
});

const client = new DynamoDBClient({ region: 'us-east-1', endpoint });
const available = await client.send(new ListTablesCommand({})).then(() => true, () => false);

// Import depois de configurar as variáveis (database.mjs lê no carregamento)
const { ProductSDK, OrderSDK, PaymentSDK, StockSDK } = await import('../../src/common/sdks/index.mjs');
const { InsufficientStockError, InvalidStateError, PaymentDeclinedError, NotFoundError, ValidationError } = await import('../../src/common/errors.mjs');
const { parsePagination } = await import('../../src/common/pagination.mjs');
const { putItem } = await import('../../src/common/database.mjs');
const { sagaDayShard } = await import('../../src/common/saga-day-index.mjs');
const { SloClient } = await import('../../src/layers/api-gateway-layer/src/services/SloClient.js');

describe('SDKs (DynamoDB)', { skip: !available && `DynamoDB indisponível em ${endpoint}` }, () => {
  const stock = new StockSDK(null);
  // Entrega ProductCreated direto ao Stock, como a regra do EventBridge faz na AWS
  const events = {
    published: [],
    async publish (event) {
      this.published.push(event);
      if (event.DetailType === 'ProductCreated') await stock.initializeStock(event.Detail);
    }
  };
  const products = new ProductSDK(events);
  const orders = new OrderSDK(null);
  const payments = new PaymentSDK(null);
  const stockOf = async productId => (await stock.getStock(productId)).available;

  before(async () => {
    // Mesmos índices do template.yaml (ex.: ActiveReservationsIndex das reservas)
    for (const [envKey, TableName] of Object.entries(TABLES)) {
      await ensureTable(client, logicalName(envKey), TableName);
    }
  });

  after(async () => {
    for (const TableName of Object.values(TABLES)) {
      await client.send(new DeleteTableCommand({ TableName })).catch(() => {});
    }
  });

  describe('ProductSDK + ProductCreated', () => {
    it('catálogo sem estoque; inventário criado pelo Stock a partir do evento', async () => {
      const p = await products.createProduct({ name: 'Z', price: 10, initialStock: 4 });
      assert.strictEqual(p.stock, undefined);
      assert.strictEqual((await products.getProduct(p.id)).stock, undefined);
      assert.strictEqual(await stockOf(p.id), 4);
    });

    it('evento repetido não altera o estoque (initializeStock idempotente)', async () => {
      const p = await products.createProduct({ name: 'Y', price: 10, initialStock: 4 });
      await stock.reserveStock({ productId: p.id, quantity: 1 });
      await stock.initializeStock({ productId: p.id, name: 'Y', initialStock: 4 });
      assert.strictEqual(await stockOf(p.id), 3);
    });

    it('updateProduct altera só os campos enviados', async () => {
      const p = await products.createProduct({ name: 'X', price: 10, description: 'desc', initialStock: 1 });
      const updated = await products.updateProduct(p.id, { price: 12 });
      assert.deepStrictEqual([updated.name, updated.price, updated.description], ['X', 12, 'desc']);
      await assert.rejects(products.updateProduct(p.id, { stock: 99 }), ValidationError);
      await assert.rejects(products.updateProduct('nao-existe', { price: 1 }), NotFoundError);
    });
  });

  describe('StockSDK', () => {
    it('aceita várias reservas do mesmo produto e debita o estoque', async () => {
      const p = await products.createProduct({ name: 'A', price: 10, initialStock: 10 });
      await stock.reserveStock({ productId: p.id, quantity: 3 });
      await stock.reserveStock({ productId: p.id, quantity: 4 });

      const s = await stock.getStock(p.id);
      assert.deepStrictEqual([s.available, s.reserved, s.activeReservations], [3, 7, 2]);
    });

    it('nunca vende além do estoque com reservas simultâneas', async () => {
      const p = await products.createProduct({ name: 'B', price: 10, initialStock: 5 });
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () => stock.reserveStock({ productId: p.id, quantity: 1 }))
      );

      const ok = results.filter(r => r.status === 'fulfilled').length;
      const rejected = results.filter(r => r.status === 'rejected');
      assert.strictEqual(ok, 5);
      // Conflito de transação também é aceitável (o Step Functions repete); estoque nunca fica negativo
      assert.ok(rejected.every(r => r.reason instanceof InsufficientStockError || r.reason.name === 'TransactionConflictException'));
      assert.strictEqual(await stockOf(p.id), 0);
    });

    it('rejeita reserva maior que o disponível', async () => {
      const p = await products.createProduct({ name: 'C', price: 10, initialStock: 2 });
      await assert.rejects(stock.reserveStock({ productId: p.id, quantity: 3 }), InsufficientStockError);
      await assert.rejects(stock.reserveStock({ productId: 'nao-existe', quantity: 1 }), NotFoundError);
    });

    it('reserva com o mesmo id é idempotente', async () => {
      const p = await products.createProduct({ name: 'D', price: 10, initialStock: 10 });
      await stock.reserveStock({ id: 'res-fixo', productId: p.id, quantity: 2 });
      await stock.reserveStock({ id: 'res-fixo', productId: p.id, quantity: 2 });
      assert.strictEqual(await stockOf(p.id), 8);
    });

    it('liberar devolve ao estoque uma única vez', async () => {
      const p = await products.createProduct({ name: 'E', price: 10, initialStock: 10 });
      const r = await stock.reserveStock({ productId: p.id, quantity: 4 });
      await stock.releaseStock({ reservationId: r.id });
      await stock.releaseStock({ reservationId: r.id });
      assert.strictEqual(await stockOf(p.id), 10);
    });

    it('ajuste não deixa o estoque negativo', async () => {
      const p = await products.createProduct({ name: 'F', price: 10, initialStock: 3 });
      assert.strictEqual((await stock.adjustStock(p.id, 5)).stock, 8);
      await assert.rejects(stock.adjustStock(p.id, -9), InsufficientStockError);
      assert.strictEqual((await stock.adjustStock(p.id, -8)).stock, 0);
    });

    it('ajuste positivo cria o inventário se o evento se perdeu', async () => {
      assert.strictEqual((await stock.adjustStock('sem-evento', 3, { name: 'W' })).stock, 3);
      assert.strictEqual((await stock.getStock('sem-evento')).name, 'W');
      await assert.rejects(stock.adjustStock('sem-evento-2', -1), NotFoundError);
    });

    it('produto excluído: inventário marcado, ProductCreated atrasado não o recria', async () => {
      const p = await products.createProduct({ name: 'Del', price: 10, initialStock: 5 });
      await stock.removeInventory({ productId: p.id });
      await stock.initializeStock({ productId: p.id, name: 'Del', initialStock: 5 });

      await assert.rejects(stock.getStock(p.id), NotFoundError);
      await assert.rejects(stock.reserveStock({ productId: p.id, quantity: 1 }), NotFoundError);
      await assert.rejects(stock.adjustStock(p.id, 3), NotFoundError);
      assert.ok(!(await stock.listStock({ productId: p.id })).stock.length);
    });

    it('reserva de produto excluído durante a compra é liberada sem inventário', async () => {
      const p = await products.createProduct({ name: 'Del2', price: 10, initialStock: 5 });
      const r = await stock.reserveStock({ productId: p.id, quantity: 2 });
      await stock.removeInventory({ productId: p.id });

      const released = await stock.releaseStock({ reservationId: r.id });
      assert.strictEqual(released.status, 'released');
      assert.strictEqual(released.inventoryMissing, true);
      assert.strictEqual((await stock.releaseStock({ reservationId: r.id })).status, 'released');
    });

    it('listagens paginadas percorrem tudo pelo nextToken', async () => {
      for (const name of ['Pag1', 'Pag2', 'Pag3']) {
        await products.createProduct({ name, price: 1, initialStock: 1 });
      }
      // Mesmo caminho do controller: o token volta pela query string
      const seen = [];
      let nextToken;
      let pages = 0;
      do {
        const page = await products.listProducts({ name: 'Pag' }, parsePagination({ limit: '2', nextToken }));
        seen.push(...page.products.map(item => item.name));
        nextToken = page.nextToken;
        pages++;
      } while (nextToken);
      assert.deepStrictEqual(seen.sort(), ['Pag1', 'Pag2', 'Pag3']);
      assert.ok(pages > 1);
    });

    it('cursor com atributos extras é aceito só pela chave (não quebra o scan)', async () => {
      const forged = Buffer.from(JSON.stringify({ id: 'prod_x', price: 1 })).toString('base64url');
      const page = await products.listProducts({}, parsePagination({ nextToken: forged }));
      assert.ok(Array.isArray(page.products));
    });

    it('filtro por productId lê o item direto, numa página só', async () => {
      const p = await products.createProduct({ name: 'Direto', price: 1, initialStock: 7 });
      const page = await stock.listStock({ productId: p.id }, { limit: 1 });
      assert.deepStrictEqual(page.stock.map(item => [item.productId, item.available]), [[p.id, 7]]);
      assert.strictEqual(page.nextToken, undefined);
      assert.deepStrictEqual((await stock.listStock({ productId: 'nao-existe' }, { limit: 1 })).stock, []);
    });
  });

  describe('OrderSDK', () => {
    it('cria, confirma e não deixa confirmar pedido cancelado', async () => {
      const o = await orders.createOrder({ productId: 'p-g', quantity: 3, unitPrice: 7 });
      assert.strictEqual(o.total, 21);

      assert.strictEqual((await orders.confirmOrder(o.id)).status, 'confirmed');
      assert.strictEqual((await orders.confirmOrder(o.id)).status, 'confirmed');
      assert.strictEqual((await orders.cancelOrder(o.id)).status, 'cancelled');
      assert.strictEqual((await orders.cancelOrder(o.id)).status, 'cancelled');
      await assert.rejects(orders.confirmOrder(o.id), InvalidStateError);
    });

    it('createOrder com o mesmo id é idempotente', async () => {
      const a = await orders.createOrder({ id: 'order-fixo', productId: 'p-h', quantity: 1, unitPrice: 1 });
      const b = await orders.createOrder({ id: 'order-fixo', productId: 'p-h', quantity: 1, unitPrice: 1 });
      assert.strictEqual(a.createdAt, b.createdAt);
    });

    it('pedido nunca criado vira voided e barra o CreateOrder atrasado', async () => {
      assert.strictEqual((await orders.cancelOrder('order-voided')).status, 'voided');
      await assert.rejects(orders.createOrder({ id: 'order-voided', productId: 'p', quantity: 1, unitPrice: 1 }), InvalidStateError);
      assert.ok(!(await orders.listOrders()).orders.some(o => o.id === 'order-voided'));
      await assert.rejects(orders.getOrder('order-voided'), NotFoundError);
      // Cancelar de novo continua idempotente
      assert.strictEqual((await orders.cancelOrder('order-voided')).status, 'voided');
    });

    it('total arredondado em centavos', async () => {
      assert.strictEqual((await orders.createOrder({ productId: 'p-c', quantity: 3, unitPrice: 19.99 })).total, 59.97);
    });

    it('exige unitPrice (vem da saga, Orders não lê produtos)', async () => {
      await assert.rejects(orders.createOrder({ productId: 'p-i', quantity: 1 }), ValidationError);
      await assert.rejects(orders.createOrder({ productId: 'p-i', quantity: 1, unitPrice: -1 }), ValidationError);
    });
  });

  describe('PaymentSDK', () => {
    it('aprova, reembolsa uma vez e recusa acima do limite', async () => {
      const pay = await payments.processPayment({ orderId: 'o1', amount: 100 });
      assert.strictEqual(pay.status, 'approved');

      const refunded = await payments.refundPaymentById(pay.id);
      const again = await payments.refundPaymentById(pay.id);
      assert.strictEqual(refunded.status, 'refunded');
      assert.strictEqual(again.refundedAt, refunded.refundedAt);

      await assert.rejects(payments.processPayment({ id: 'pay-caro', orderId: 'o2', amount: 5000 }), PaymentDeclinedError);
      // repetir a mesma tentativa continua recusada (idempotente)
      await assert.rejects(payments.processPayment({ id: 'pay-caro', orderId: 'o2', amount: 5000 }), PaymentDeclinedError);
      assert.strictEqual((await payments.getPayment('pay-caro')).status, 'declined');
    });
  });

  describe('SagasByDayIndex (aba SLOs)', () => {
    it('lê as sagas da janela pelo índice, sem as anteriores a ela', async () => {
      const now = Date.now();
      const sagaAt = async (id, agoMs, status) => {
        const createdAt = new Date(now - agoMs).toISOString();
        const updatedAt = new Date(now - agoMs + 500).toISOString();
        await putItem('sagas', { id, status, createdAt, updatedAt, dayShard: sagaDayShard(id, createdAt) });
      };
      await sagaAt('saga_it_recent', 60 * 1000, 'COMPLETED');
      await sagaAt('saga_it_failed', 2 * 60 * 1000, 'COMPENSATION_FAILED');
      await sagaAt('saga_it_old', 3 * 24 * 60 * 60 * 1000, 'COMPLETED');

      const dlq = { async listMessages() { return { queue: 'q', approximateTotal: 0, messages: [] }; } };
      const result = await new SloClient({ dlq, now: () => now }).evaluate({ hours: 24 });
      const outcome = result.slos.find(slo => slo.id === 'saga-outcome');
      assert.strictEqual(outcome.sample, 2);
      assert.strictEqual(outcome.detail.byStatus.COMPENSATION_FAILED, 1);
      assert.strictEqual(result.slos.find(slo => slo.id === 'purchase-latency').detail.p95, 500);
    });
  });
});
