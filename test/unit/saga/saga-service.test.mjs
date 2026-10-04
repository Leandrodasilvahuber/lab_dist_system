import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SagaService, STUCK_START_MS, parseLambdaError, sagaIdFromKey } from '../../../src/ecommerce/saga-orchestrator/src/services/SagaService.js';
import { DependencyUnavailableError, IdempotencyConflictError, NotFoundError, ValidationError } from '../../../src/common/errors.mjs';

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
    if (condition.includes('size(steps)') && Object.keys(item.steps).length !== 0) throw fail();
    if (condition.includes('#status = :running') && item.status !== values[':running']) throw fail();
    if (condition.includes(':attempt') && item.startAttempts !== values[':attempt']) throw fail();
    if (condition.includes(':seen') && (item.updatedAt !== values[':seen'] || item.executionArn)) throw fail();
    if (values[':now']) item.updatedAt = values[':now'];

    if (expression.includes('executionArn')) item.executionArn = values[':arn'];
    if (expression.includes('executionName')) item.executionName = values[':name'];
    if (values[':status']) item.status = values[':status'];
    if (values[':error']) item.error = values[':error'];
    if (expression.includes('REMOVE #error')) delete item.error;
    if (expression.includes('startAttempts')) item.startAttempts = (item.startAttempts || 1) + 1;
    return structuredClone(item);
  }
  async scanPage(table, { limit } = {}) {
    const items = [...this.tables[table].values()];
    return { items: items.slice(0, limit), lastKey: limit < items.length ? { id: items[limit - 1].id } : undefined };
  }
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

// Como o Step Functions STANDARD: mesmo nome e mesmo input de uma execução em
// andamento devolve a mesma; nome de execução já encerrada falha
class FakeStepFunctions {
  constructor({ fail = false } = {}) { this.fail = fail; this.started = []; this.closed = new Set(); }
  async startExecution(name, input) {
    if (this.fail) throw new Error('SFN indisponível');
    if (this.closed.has(name)) throw Object.assign(new Error('exists'), { name: 'ExecutionAlreadyExists' });
    const running = this.started.find(e => e.name === name);
    if (running) {
      assert.deepStrictEqual(running.input, input);
      return `arn:aws:states:::execution:saga:${name}`;
    }
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
    const { saga, created } = await service.startSaga({ productId: 'apple', quantity: 2, idempotencyKey: 'k-start' });

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
    const { saga } = await service.startSaga({ productId: 'apple', quantity: 2, idempotencyKey: 'k-start' });
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
    await assert.rejects(service.startSaga({ productId: 'nope', quantity: 1, idempotencyKey: 'k-nope' }), NotFoundError);
    assert.strictEqual(sfn.started.length, 0);
  });

  it('valida quantidade', async () => {
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 0, idempotencyKey: 'k-q0' }), ValidationError);
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 1.5, idempotencyKey: 'k-q15' }), ValidationError);
  });

  it('exige a idempotencyKey', async () => {
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 1 }), ValidationError);
    assert.strictEqual(sfn.started.length, 0);
  });

  it('marca FAILED e responde 503 se o Step Functions não iniciar', async () => {
    service = new SagaService({ db, stepFunctions: new FakeStepFunctions({ fail: true }), productClient });
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'k' }),
      // logged: o SAGA_START_FAILED já registrou; a resposta HTTP não conta de novo
      error => error instanceof DependencyUnavailableError && error.logged === true);
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
    // mesmo nome da tentativa anterior (que não chegou a criar a execução)
    assert.strictEqual(failing.started[0].name, saga.id);
  });

  it('nova tentativa depois de um timeout em que a execução começou não cria uma segunda', async () => {
    // A execução foi criada, mas a resposta não chegou (timeout do cliente)
    const lost = new FakeStepFunctions();
    lost.startExecution = async function (name, input) {
      await FakeStepFunctions.prototype.startExecution.call(this, name, input);
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    };
    service = new SagaService({ db, stepFunctions: lost, productClient });
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'timeout' }), DependencyUnavailableError);

    lost.startExecution = FakeStepFunctions.prototype.startExecution;
    const { saga } = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'timeout' });
    assert.strictEqual(saga.status, 'RUNNING');
    assert.strictEqual(lost.started.length, 1);
    assert.strictEqual(saga.executionArn, `arn:aws:states:::execution:saga:${saga.id}`);
  });

  it('usa nome novo, e o grava, se a execução anterior já terminou', async () => {
    const failing = new FakeStepFunctions({ fail: true });
    service = new SagaService({ db, stepFunctions: failing, productClient });
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'closed' }));

    failing.fail = false;
    failing.closed.add(sagaIdFromKey('closed'));
    const { saga } = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'closed' });
    assert.strictEqual(failing.started[0].name, `${saga.id}-2`);
    assert.strictEqual(db.tables.sagas.get(saga.id).executionName, `${saga.id}-2`);
  });

  it('se outra requisição reiniciou a saga antes de gravar o nome novo, responde 503 sem marcá-la como falha', async () => {
    const failing = new FakeStepFunctions({ fail: true });
    service = new SagaService({ db, stepFunctions: failing, productClient });
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'race' }));

    failing.fail = false;
    const id = sagaIdFromKey('race');
    failing.closed.add(id);
    // Outra requisição avança startAttempts entre o reinício e a gravação do nome
    const updateItem = db.updateItem.bind(db);
    db.updateItem = async (table, key, expression, ...rest) => {
      if (expression.includes('executionName')) db.tables.sagas.get(id).startAttempts += 1;
      return updateItem(table, key, expression, ...rest);
    };
    await assert.rejects(
      service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'race' }),
      error => error instanceof DependencyUnavailableError && /another request/.test(error.message)
    );
    assert.strictEqual(db.tables.sagas.get(id).status, 'RUNNING');
    assert.strictEqual(failing.started.length, 0);
  });

  it('saga presa em RUNNING sem execução (a Lambda morreu antes de iniciar) é iniciada de novo', async () => {
    const id = sagaIdFromKey('stuck');
    const updatedAt = new Date(Date.now() - STUCK_START_MS - 1000).toISOString();
    db.tables.sagas.set(id, { id, status: 'RUNNING', productId: 'apple', quantity: 1, unitPrice: 5, correlationId: id,
      orderId: `order_${id}`, paymentId: `pay_${id}`, reservationId: `res_${id}`, startAttempts: 1, executionName: id,
      steps: {}, createdAt: updatedAt, updatedAt });

    const { saga, created } = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'stuck' });
    assert.strictEqual(created, true);
    assert.strictEqual(sfn.started[0].name, id);
    assert.strictEqual(db.tables.sagas.get(id).executionArn, `arn:aws:states:::execution:saga:${id}`);
    assert.strictEqual(saga.startAttempts, 2);
  });

  it('saga RUNNING sem execução há pouco tempo não é reiniciada (pode estar iniciando)', async () => {
    const id = sagaIdFromKey('starting');
    const now = new Date().toISOString();
    db.tables.sagas.set(id, { id, status: 'RUNNING', productId: 'apple', quantity: 1, steps: {}, createdAt: now, updatedAt: now });

    const { created } = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'starting' });
    assert.strictEqual(created, false);
    assert.strictEqual(sfn.started.length, 0);
  });

  it('saga START_FAILED que já registrou passos não é reiniciada (a execução rodou)', async () => {
    const id = sagaIdFromKey('ran');
    db.tables.sagas.set(id, { id, status: 'FAILED', error: 'StartExecutionFailed', productId: 'apple', quantity: 1,
      startAttempts: 1, executionName: id, steps: { createOrder: { status: 'COMPLETED' } } });

    const { created } = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'ran' });
    assert.strictEqual(created, false);
    assert.strictEqual(sfn.started.length, 0);
  });

  it('se nem marcar a falha ao iniciar der certo, ainda responde 503 com a causa original', async () => {
    service = new SagaService({ db, stepFunctions: new FakeStepFunctions({ fail: true }), productClient });
    const updateItem = db.updateItem.bind(db);
    db.updateItem = async (table, key, expression, ...rest) => {
      if (expression.includes(':error')) throw Object.assign(new Error('DynamoDB fora do ar'), { name: 'InternalServerError' });
      return updateItem(table, key, expression, ...rest);
    };
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'mark-fails' }),
      error => error instanceof DependencyUnavailableError && error.cause.message === 'SFN indisponível');
    // Fica RUNNING sem execução: a mesma chave a reinicia depois de STUCK_START_MS
    assert.strictEqual(db.tables.sagas.get(sagaIdFromKey('mark-fails')).status, 'RUNNING');
  });

  it('saga antiga, sem executionName, repete o nome da tentativa anterior (<id>-<n>)', async () => {
    const id = sagaIdFromKey('legacy');
    db.tables.sagas.set(id, { id, status: 'FAILED', error: 'StartExecutionFailed', productId: 'apple', quantity: 1,
      unitPrice: 5, correlationId: id, orderId: `order_${id}`, paymentId: `pay_${id}`, reservationId: `res_${id}`,
      startAttempts: 2, steps: {} });

    await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'legacy' });
    // A 2ª tentativa (código antigo) usou <id>-2; esta é a 3ª
    assert.strictEqual(sfn.started[0].name, `${id}-2`);
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
    const { saga } = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'k-get' });
    db.tables.sagas.get(saga.id).steps = { createOrder: { status: 'COMPLETED' }, processPayment: { status: 'COMPLETED' } };

    const result = await service.getSaga(saga.id);
    assert.strictEqual(result.progress.completed, 2);
    await assert.rejects(service.getSaga('x'), NotFoundError);
  });

  it('listSagas lê uma página por vez e devolve o nextToken', async () => {
    for (let i = 0; i < 3; i++) await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: `k-list-${i}` });

    const first = await service.listSagas({}, { limit: 2 });
    assert.strictEqual(first.sagas.length, 2);
    assert.ok(first.nextToken);
    assert.ok(first.sagas.every(s => s.progress));

    const all = await service.listSagas({}, { limit: 10 });
    assert.strictEqual(all.sagas.length, 3);
    assert.strictEqual(all.nextToken, undefined);
    assert.strictEqual((await service.listSagas({ status: 'COMPLETED' }, { limit: 10 })).sagas.length, 0);
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
