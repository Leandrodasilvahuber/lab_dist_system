import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { PaymentSDK } from '../../../src/common/sdks/PaymentSDK.js';
import { StockSDK } from '../../../src/common/sdks/StockSDK.js';
import { OrderSDK } from '../../../src/common/sdks/OrderSDK.js';
import { ProductSDK } from '../../../src/common/sdks/ProductSDK.js';
import { InvalidStateError } from '../../../src/common/errors.mjs';

process.env.LOG_LEVEL = 'silent';

const conditionFailed = () => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });

// Banco em memória: get/put/delete genéricos; updateItem e transactWrite
// simulam só as expressões usadas nos casos abaixo
class MapDb {
  constructor() { this.tables = {}; this.calls = []; }
  table(name) { return (this.tables[name] ||= new Map()); }
  async getItem(table, { id }) { return structuredClone(this.table(table).get(id)); }
  async putItem(table, item) { this.table(table).set(item.id, structuredClone(item)); return item; }
  async putItemIfNotExists(table, item) {
    if (this.table(table).has(item.id)) return false;
    this.table(table).set(item.id, structuredClone(item));
    return true;
  }
  async deleteItem(table, { id }) { this.calls.push(['deleteItem', table, id]); this.table(table).delete(id); }
  async updateItem(table, { id }, expression, values, options = {}) {
    this.calls.push(['updateItem', table, id]);
    const item = this.table(table).get(id);
    if (options.conditionExpression === '#status = :active' && item.status !== 'active') throw conditionFailed();
    if (values[':committed']) item.status = 'committed';
    if (values[':refunded']) item.status = 'refunded';
    return structuredClone(item);
  }
  async transactWrite(operations) {
    this.calls.push(['transactWrite']);
    const put = operations[0].Put;
    if (put && this.table('stockReservations').has(put.Item.id)) {
      throw Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }]
      });
    }
    if (put) this.table('stockReservations').set(put.Item.id, structuredClone(put.Item));
  }
}

describe('compensações da saga', () => {
  let db;
  beforeEach(() => { db = new MapDb(); });

  it('reembolso de pagamento nunca gravado anula o id e barra a cobrança atrasada', async () => {
    const payments = new PaymentSDK(null, db);
    const result = await payments.refundPaymentById('pay_1');
    assert.strictEqual(result.status, 'voided');

    await assert.rejects(payments.processPayment({ id: 'pay_1', orderId: 'o1', amount: 10 }), InvalidStateError);
    assert.strictEqual(db.table('payments').get('pay_1').status, 'voided');
  });

  it('reembolso de pagamento recusado não faz nada', async () => {
    const payments = new PaymentSDK(null, db);
    await db.putItem('payments', { id: 'pay_2', status: 'declined', amount: 20000 });
    assert.strictEqual((await payments.refundPaymentById('pay_2')).status, 'declined');
    assert.ok(!db.calls.some(([op]) => op === 'updateItem'));
  });

  it('reembolso não aceita valor maior que o pago', async () => {
    const payments = new PaymentSDK(null, db);
    await db.putItem('payments', { id: 'pay_3', status: 'approved', amount: 50 });
    await assert.rejects(payments.refundPaymentById('pay_3', 80), /Refund amount/);
    assert.strictEqual((await payments.refundPaymentById('pay_3')).status, 'refunded');
  });

  it('liberação de reserva nunca gravada grava "released" e barra a reserva atrasada', async () => {
    const stock = new StockSDK(null, db);
    const result = await stock.releaseStock({ reservationId: 'res_1' });
    assert.strictEqual(result.status, 'released');

    await assert.rejects(stock.reserveStock({ id: 'res_1', productId: 'p1', quantity: 1 }), InvalidStateError);
  });

  it('reserva repetida (mesmo id, ainda ativa) devolve a reserva existente', async () => {
    const stock = new StockSDK(null, db);
    const first = await stock.reserveStock({ id: 'res_2', productId: 'p1', quantity: 1 });
    const again = await stock.reserveStock({ id: 'res_2', productId: 'p1', quantity: 1 });
    assert.strictEqual(again.id, first.id);
    assert.strictEqual(again.status, 'active');
  });

  it('cancelar pedido nunca criado anula o id e barra o CreateOrder atrasado', async () => {
    const orders = new OrderSDK(null, db);
    assert.strictEqual((await orders.cancelOrder('order_x')).status, 'voided');
    await assert.rejects(orders.createOrder({ id: 'order_x', productId: 'p1', quantity: 1, unitPrice: 5 }), InvalidStateError);
  });
});

describe('ciclo de vida da reserva', () => {
  it('commit muda active -> committed e repetir não é erro', async () => {
    const db = new MapDb();
    const stock = new StockSDK(null, db);
    await db.putItem('stockReservations', { id: 'r1', productId: 'p1', quantity: 2, status: 'active' });

    assert.strictEqual((await stock.commitReservation({ reservationId: 'r1' })).status, 'committed');
    assert.strictEqual((await stock.commitReservation({ reservationId: 'r1' })).status, 'committed');
    assert.strictEqual(db.calls.filter(([op]) => op === 'updateItem').length, 1);
  });

  it('não confirma uma reserva já liberada', async () => {
    const db = new MapDb();
    const stock = new StockSDK(null, db);
    await db.putItem('stockReservations', { id: 'r2', productId: 'p1', quantity: 2, status: 'released' });
    await assert.rejects(stock.commitReservation({ reservationId: 'r2' }), InvalidStateError);
  });

  it('reservas ativas vêm do GSI de status, sem scan', async () => {
    const queries = [];
    const db = {
      getItem: async () => ({ id: 'p1', name: 'Teclado', stock: 5 }),
      queryItems: async (table, params) => { queries.push([table, params]); return [{ quantity: 2 }, { quantity: 1 }]; },
      scanItems: async (table) => { if (table !== 'inventory') throw new Error(`scan em ${table}`); return []; }
    };
    const stock = new StockSDK(null, db);
    const result = await stock.getStock('p1');

    assert.strictEqual(result.reserved, 3);
    assert.strictEqual(queries[0][1].IndexName, 'StatusIndex');
    assert.deepStrictEqual(queries[0][1].ExpressionAttributeValues, { ':active': 'active', ':productId': 'p1' });
  });
});

describe('ProductSDK.createProduct', () => {
  it('o id é sempre gerado pelo serviço (não vem do cliente)', async () => {
    const db = new MapDb();
    const product = await new ProductSDK(null, db).createProduct({ id: 'hack', name: 'X', price: 1 });
    assert.notStrictEqual(product.id, 'hack');
    assert.match(product.id, /^prod_/);
  });

  it('desfaz o produto se ProductCreated não puder ser publicado', async () => {
    const db = new MapDb();
    const published = [];
    const bus = {
      publish: async (event, options) => {
        published.push(event.DetailType);
        if (event.DetailType === 'ProductCreated') {
          assert.deepStrictEqual(options, { required: true });
          throw new Error('EventBridge fora');
        }
      }
    };
    await assert.rejects(new ProductSDK(bus, db).createProduct({ name: 'X', price: 1, initialStock: 3 }), /EventBridge fora/);
    assert.strictEqual(db.table('products').size, 0);
    // O evento pode ter sido entregue apesar do erro: o Stock remove o inventário órfão
    assert.deepStrictEqual(published, ['ProductCreated', 'ProductDeleted']);
  });

  it('rollback que falha ainda publica ProductDeleted e relança o erro original', async () => {
    const db = new MapDb();
    db.deleteItem = async () => { throw new Error('DynamoDB fora'); };
    const published = [];
    const bus = {
      publish: async event => {
        published.push(event.DetailType);
        if (event.DetailType === 'ProductCreated') throw new Error('EventBridge fora');
        throw new Error('ProductDeleted também falhou');
      }
    };
    await assert.rejects(new ProductSDK(bus, db).createProduct({ name: 'X', price: 1 }), /EventBridge fora/);
    assert.deepStrictEqual(published, ['ProductCreated', 'ProductDeleted']);
  });
});
