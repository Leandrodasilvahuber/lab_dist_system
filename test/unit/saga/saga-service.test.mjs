import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SagaService, parseLambdaError, sagaIdFromKey } from '../../../src/ecommerce/saga-orchestrator/src/services/SagaService.js';
import { IdempotencyConflictError, NotFoundError, ValidationError } from '../../../src/common/errors.mjs';

// Banco em memória com o subconjunto usado pelo SagaService
class FakeDb {
  constructor() { this.tables = { sagas: new Map() }; }
  async getItem(table, { id }) { return this.tables[table].get(id); }
  async putItemIfNotExists(table, item) {
    if (this.tables[table].has(item.id)) return false;
    this.tables[table].set(item.id, structuredClone(item));
    return true;
  }
  // Simula só as expressões usadas pelo SagaService
  async updateItem(table, { id }, expression, values, options = {}) {
    const item = this.tables[table].get(id);
    const condition = options.conditionExpression || '';
    const fail = () => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
    if (condition.includes(':startFailed') && !(item.status === values[':failed'] && item.error === values[':startFailed'])) throw fail();
    if (condition.includes('size(steps)') && !(item.status === values[':running'] && Object.keys(item.steps).length === 0)) throw fail();

    if (expression.includes('executionArn')) item.executionArn = values[':arn'];
    if (values[':status']) item.status = values[':status'];
    if (values[':error']) item.error = values[':error'];
    if (expression.includes('REMOVE #error')) delete item.error;
    if (expression.includes('startAttempts')) item.startAttempts = (item.startAttempts || 1) + 1;
    return structuredClone(item);
  }
  async scanItems(table) { return [...this.tables[table].values()]; }
}

// Serviço de Products (na AWS, Lambda invoke via ProductClient)
class FakeProductClient {
  constructor(products) { this.products = products; this.calls = 0; }
  async getProduct(productId) {
    this.calls++;
    const product = this.products[productId];
    if (!product) throw new NotFoundError('Product not found');
    return product;
  }
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
  let db, sfn, productClient, service;

  beforeEach(() => {
    db = new FakeDb();
    sfn = new FakeStepFunctions();
    productClient = new FakeProductClient({ apple: { id: 'apple', price: 5 } });
    service = new SagaService({ db, stepFunctions: sfn, productClient });
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

  it('consulta o serviço de Products e envia o preço congelado à execução', async () => {
    const { saga } = await service.startSaga({ productId: 'apple', quantity: 2 });
    assert.strictEqual(productClient.calls, 1);
    assert.strictEqual(sfn.started[0].input.unitPrice, 5);
    assert.strictEqual(saga.unitPrice, 5);
  });

  it('mesma idempotencyKey devolve a saga existente sem nova execução', async () => {
    const first = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'abc/123' });
    const second = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'abc/123' });

    assert.strictEqual(second.created, false);
    assert.strictEqual(second.saga.id, first.saga.id);
    assert.strictEqual(first.saga.id, sagaIdFromKey('abc/123'));
    assert.strictEqual(sfn.started.length, 1);
  });

  it('chaves diferentes nunca colidem, mesmo com caracteres inválidos ou longas', () => {
    assert.notStrictEqual(sagaIdFromKey('a.b'), sagaIdFromKey('a_b'));
    const long = 'x'.repeat(100);
    assert.notStrictEqual(sagaIdFromKey(long + '1'), sagaIdFromKey(long + '2'));
    assert.match(sagaIdFromKey('qualquer/coisa ç'), /^saga_[a-f0-9]{48}$/);
    // nome de execução (id + "-N" nas novas tentativas) cabe nos 80 caracteres
    assert.ok(`${sagaIdFromKey('k')}-99`.length <= 80);
  });

  it('mesma idempotencyKey com outro pedido responde conflito', async () => {
    await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'k1' });
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 2, idempotencyKey: 'k1' }), IdempotencyConflictError);
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
    service = new SagaService({ db, stepFunctions: new FakeStepFunctions({ fail: true }), productClient });
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'k' }));
    const saga = db.tables.sagas.get(sagaIdFromKey('k'));
    assert.strictEqual(saga.status, 'FAILED');
    assert.strictEqual(saga.error, 'StartExecutionFailed');
  });

  it('nova tentativa com a mesma chave reinicia a saga que falhou ao iniciar', async () => {
    const failing = new FakeStepFunctions({ fail: true });
    service = new SagaService({ db, stepFunctions: failing, productClient });
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'retry' }));

    failing.fail = false;
    const { saga, created } = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'retry' });
    assert.strictEqual(created, true);
    assert.strictEqual(saga.status, 'RUNNING');
    assert.strictEqual(saga.error, undefined);
    // nome de execução novo: o Step Functions não aceita repetir nomes
    assert.strictEqual(failing.started[0].name, `${saga.id}-2`);
  });

  it('não marca FAILED se a execução já começou a registrar passos', async () => {
    const sfnLost = { startExecution: async (name) => {
      db.tables.sagas.get(name).steps = { createOrder: { status: 'COMPLETED' } };
      throw new Error('resposta perdida');
    } };
    service = new SagaService({ db, stepFunctions: sfnLost, productClient });
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'lost' }));
    assert.strictEqual(db.tables.sagas.get(sagaIdFromKey('lost')).status, 'RUNNING');
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
