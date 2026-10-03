import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SagaService, parseLambdaError } from '../../../src/ecommerce/saga-orchestrator/src/services/SagaService.js';
import { NotFoundError, ValidationError } from '../../../src/common/errors.mjs';

// Banco em memória com o subconjunto usado pelo SagaService
class FakeDb {
  constructor() { this.tables = { sagas: new Map(), products: new Map() }; }
  async getItem(table, { id }) { return this.tables[table].get(id); }
  async putItemIfNotExists(table, item) {
    if (this.tables[table].has(item.id)) return false;
    this.tables[table].set(item.id, structuredClone(item));
    return true;
  }
  async updateItem(table, { id }, expression, values) {
    const item = this.tables[table].get(id);
    if (expression.includes('executionArn')) item.executionArn = values[':arn'];
    if (values[':status']) item.status = values[':status'];
  }
  async scanItems(table) { return [...this.tables[table].values()]; }
}

class FakeStepFunctions {
  constructor({ fail = false } = {}) { this.fail = fail; this.started = []; }
  async startExecution(name, input) {
    if (this.fail) throw new Error('SFN indisponível');
    this.started.push({ name, input });
    return `arn:aws:states:::execution:saga:${name}`;
  }
}

describe('SagaService', () => {
  let db, sfn, service;

  beforeEach(() => {
    db = new FakeDb();
    db.tables.products.set('apple', { id: 'apple', price: 5, stock: 10 });
    sfn = new FakeStepFunctions();
    service = new SagaService({ db, stepFunctions: sfn });
  });

  it('cria o registro RUNNING e inicia a execução com ids determinísticos', async () => {
    const { saga, created } = await service.startSaga({ productId: 'apple', quantity: 2 });

    assert.strictEqual(created, true);
    assert.strictEqual(saga.status, 'RUNNING');
    assert.strictEqual(sfn.started.length, 1);
    assert.strictEqual(sfn.started[0].name, saga.id);
    assert.deepStrictEqual(sfn.started[0].input.ids, {
      orderId: `order_${saga.id}`,
      paymentId: `pay_${saga.id}`,
      reservationId: `res_${saga.id}`
    });
    assert.ok(db.tables.sagas.get(saga.id).executionArn);
  });

  it('mesma idempotencyKey devolve a saga existente sem nova execução', async () => {
    const first = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'abc/123' });
    const second = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'abc/123' });

    assert.strictEqual(second.created, false);
    assert.strictEqual(second.saga.id, first.saga.id);
    assert.strictEqual(first.saga.id, 'saga_abc_123');
    assert.strictEqual(sfn.started.length, 1);
  });

  it('produto inexistente falha antes de iniciar a execução', async () => {
    await assert.rejects(service.startSaga({ productId: 'nope', quantity: 1 }), NotFoundError);
    assert.strictEqual(sfn.started.length, 0);
  });

  it('valida quantidade', async () => {
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 0 }), ValidationError);
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 1.5 }), ValidationError);
  });

  it('marca FAILED se o Step Functions não iniciar', async () => {
    service = new SagaService({ db, stepFunctions: new FakeStepFunctions({ fail: true }) });
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'k' }));
    assert.strictEqual(db.tables.sagas.get('saga_k').status, 'FAILED');
  });

  it('getSaga calcula o progresso e lança NotFound', async () => {
    const { saga } = await service.startSaga({ productId: 'apple', quantity: 1 });
    db.tables.sagas.get(saga.id).steps = { createOrder: { status: 'COMPLETED' }, processPayment: { status: 'COMPLETED' } };

    const result = await service.getSaga(saga.id);
    assert.strictEqual(result.progress.completed, 2);
    await assert.rejects(service.getSaga('x'), NotFoundError);
  });
});

describe('parseLambdaError', () => {
  it('extrai tipo e mensagem do erro gravado pelo Step Functions', () => {
    const raw = JSON.stringify({
      Error: 'PaymentDeclined',
      Cause: JSON.stringify({ errorType: 'PaymentDeclined', errorMessage: 'Payment declined', trace: ['...'] })
    });
    assert.deepStrictEqual(parseLambdaError(raw), { type: 'PaymentDeclined', message: 'Payment declined' });
  });

  it('não quebra com conteúdo inesperado', () => {
    assert.strictEqual(parseLambdaError('???').type, 'Unknown');
  });
});
