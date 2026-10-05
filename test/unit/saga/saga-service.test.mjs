import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SagaService, MAX_PURCHASE_QUANTITY, STUCK_START_MS, RECONCILE_MAX, finalStatus, parseLambdaError, sagaIdFromKey } from '../../../src/ecommerce/saga-orchestrator/src/services/SagaService.js';
import { sagaDayShard } from '../../../src/common/saga-day-index.mjs';
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
    if (condition.includes(':expectedAt') && (item.status !== values[':expectedStatus'] || item.updatedAt !== values[':expectedAt'])) throw fail();
    if (values[':execution']) item.reconciledFrom = values[':execution'];
    if (expression.includes('compensationError')) item.compensationError = values[':error'];
    if (values[':endedAt']) {
      item.updatedAt = values[':endedAt'];
      item.reconciledAt = values[':now'];
    } else if (values[':now']) item.updatedAt = values[':now'];

    if (expression.includes('executionArn')) item.executionArn = values[':arn'];
    if (expression.includes('executionName')) item.executionName = values[':name'];
    if (values[':status']) item.status = values[':status'];
    if (values[':error'] && !expression.includes('compensationError')) item.error = values[':error'];
    if (expression.includes('REMOVE #error')) delete item.error;
    if (expression.includes('startAttempts')) item.startAttempts = (item.startAttempts || 1) + 1;
    return structuredClone(item);
  }
  // SagasByDayIndex: só o que a varredura usa (dayShard + createdAt >= :since)
  async queryItems(table, { ExpressionAttributeValues: v }) {
    return [...this.tables[table].values()]
      .filter(item => item.dayShard === v[':dayShard'] && item.createdAt >= v[':since'])
      .map(({ id, dayShard, createdAt, status, updatedAt }) => ({ id, dayShard, createdAt, status, updatedAt }));
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
  constructor({ fail = false, executions = {} } = {}) { this.fail = fail; this.started = []; this.closed = new Set(); this.executions = executions; this.described = 0; }
  executionArn(name) { return `arn:aws:states:::execution:saga:${name}`; }
  async describeExecution(arn) {
    this.described++;
    if (!this.executions[arn]) throw new Error('SFN indisponível');
    return this.executions[arn];
  }
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

  it('productId longo demais: 400 antes de consultar o Products', async () => {
    let looked = false;
    service.productClient = { getProduct: async () => { looked = true; } };
    await assert.rejects(service.startSaga({ productId: 'x'.repeat(5000), quantity: 1, idempotencyKey: 'k-long-product' }), ValidationError);
    assert.strictEqual(looked, false);
    assert.strictEqual(sfn.started.length, 0);
  });

  it('quantity acima do teto: 400 antes de consultar o Products', async () => {
    let looked = false;
    service.productClient = { getProduct: async () => { looked = true; } };
    await assert.rejects(service.startSaga({ productId: 'apple', quantity: MAX_PURCHASE_QUANTITY + 1, idempotencyKey: 'k-too-many' }), ValidationError);
    assert.strictEqual(looked, false);
    // O teto em si é aceito
    service.productClient = productClient;
    const { created } = await service.startSaga({ productId: 'apple', quantity: MAX_PURCHASE_QUANTITY, idempotencyKey: 'k-max' });
    assert.strictEqual(created, true);
  });

  it('saga criada antes do teto: a mesma chave devolve a saga existente, não 400', async () => {
    const key = 'k-before-cap-000001';
    const id = sagaIdFromKey(key);
    db.tables.sagas.set(id, { id, status: 'COMPLETED', productId: 'apple', quantity: MAX_PURCHASE_QUANTITY + 500, steps: {}, updatedAt: new Date().toISOString() });
    const { saga, created } = await service.startSaga({ productId: 'apple', quantity: MAX_PURCHASE_QUANTITY + 500, idempotencyKey: key });
    assert.deepStrictEqual([saga.id, saga.status, created], [id, 'COMPLETED', false]);
  });

  it('getSaga com id longo demais: ValidationError, não erro do banco', async () => {
    await assert.rejects(service.getSaga('x'.repeat(5000)), ValidationError);
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

  it('grava a chave do SagasByDayIndex a partir do id e da criação', async () => {
    const { saga } = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'k-day-shard' });
    const stored = db.tables.sagas.get(saga.id);
    assert.strictEqual(stored.dayShard, sagaDayShard(saga.id, stored.createdAt));
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

  // GET /saga/{id} é público: o executionArn traria o ID da conta AWS
  it('getSaga e listSagas não devolvem os campos internos do orquestrador', async () => {
    const { saga } = await service.startSaga({ productId: 'apple', quantity: 1, idempotencyKey: 'k-internal' });
    assert.ok(db.tables.sagas.get(saga.id).executionArn);

    const result = await service.getSaga(saga.id);
    const { sagas } = await service.listSagas({}, { limit: 10 });
    for (const view of [result, sagas.find(s => s.id === saga.id)]) {
      for (const field of ['executionArn', 'executionName', 'startAttempts', 'dayShard']) {
        assert.strictEqual(field in view, false, field);
      }
      assert.strictEqual(view.status, 'RUNNING');
    }
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
  // Throttling vem do serviço Lambda: a Cause é texto, não o JSON da função
  it('erro do serviço Lambda (Cause em texto) vira tipo e mensagem legível', () => {
    const raw = JSON.stringify({
      Error: 'Lambda.TooManyRequestsException',
      Cause: 'Rate Exceeded. (Service: AWSLambda; Status Code: 429; Error Code: TooManyRequestsException)'
    });
    assert.deepStrictEqual(parseLambdaError(raw), {
      type: 'Lambda.TooManyRequestsException',
      message: 'Service busy: too many purchases at the same time, please try again'
    });
    // Outro erro com Cause em texto: a própria Cause, sem cair em Unknown
    assert.deepStrictEqual(parseLambdaError(JSON.stringify({ Error: 'Lambda.ServiceException', Cause: 'boom' })),
      { type: 'Lambda.ServiceException', message: 'boom' });
  });

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

describe('SagaService: reconciliação de saga parada', () => {
  const NOW = Date.parse('2026-10-05T12:00:00Z');
  const ago = ms => new Date(NOW - ms).toISOString();

  function setup(saga, execution) {
    const db = new FakeDb();
    const arn = `arn:aws:states:::execution:saga:${saga.id}`;
    db.tables.sagas.set(saga.id, {
      productId: 'p1', quantity: 1, steps: {}, executionArn: arn,
      createdAt: saga.updatedAt, dayShard: sagaDayShard(saga.id, saga.updatedAt), ...saga
    });
    const stepFunctions = new FakeStepFunctions({ executions: execution ? { [arn]: execution } : {} });
    return { db, stepFunctions, service: new SagaService({ db, stepFunctions, productClient: new FakeProductClient({}), now: () => NOW }) };
  }

  it('status final pelo desfecho da execução', () => {
    assert.strictEqual(finalStatus({ status: 'RUNNING' }), null);
    assert.deepStrictEqual(finalStatus({ status: 'SUCCEEDED' }), { status: 'COMPLETED' });
    assert.deepStrictEqual(finalStatus({ status: 'FAILED', error: 'SagaCompensated' }), { status: 'COMPENSATED' });
    assert.deepStrictEqual(finalStatus({ status: 'FAILED', error: 'SagaFailed' }), { status: 'FAILED' });
    assert.deepStrictEqual(finalStatus({ status: 'FAILED', error: 'CompensationFailed' }), { status: 'COMPENSATION_FAILED' });
    // Encerrada sem compensar: intervenção manual
    assert.deepStrictEqual(finalStatus({ status: 'TIMED_OUT' }), { status: 'COMPENSATION_FAILED', error: 'ExecutionTIMED_OUT' });
    assert.deepStrictEqual(finalStatus({ status: 'ABORTED' }), { status: 'COMPENSATION_FAILED', error: 'ExecutionABORTED' });
    assert.deepStrictEqual(finalStatus({ status: 'FAILED', error: 'States.Runtime' }), { status: 'COMPENSATION_FAILED', error: 'ExecutionFailed:States.Runtime' });
  });

  it('getSaga corrige a saga RUNNING cuja execução já terminou', async () => {
    const { service } = setup({ id: 'saga_a', status: 'RUNNING', updatedAt: ago(6 * 60 * 1000) }, { status: 'SUCCEEDED' });
    const saga = await service.getSaga('saga_a');
    assert.strictEqual(saga.status, 'COMPLETED');
    assert.strictEqual(saga.reconciledFrom, 'SUCCEEDED');
  });

  it('a saga corrigida guarda o fim real da execução em updatedAt (duração na aba SLOs)', async () => {
    const stopDate = new Date(NOW - 5.5 * 60 * 1000);
    const { db, service } = setup({ id: 'saga_t', status: 'RUNNING', updatedAt: ago(6 * 60 * 1000) }, { status: 'SUCCEEDED', stopDate });
    await service.getSaga('saga_t');
    const saved = db.tables.sagas.get('saga_t');
    assert.strictEqual(saved.updatedAt, stopDate.toISOString());
    assert.strictEqual(saved.reconciledAt, new Date(NOW).toISOString());
  });

  it('execução que estourou o teto vira COMPENSATION_FAILED (intervenção manual)', async () => {
    const { service } = setup({ id: 'saga_b', status: 'COMPENSATING', updatedAt: ago(20 * 60 * 1000) }, { status: 'TIMED_OUT' });
    const saga = await service.getSaga('saga_b');
    assert.strictEqual(saga.status, 'COMPENSATION_FAILED');
    assert.strictEqual(saga.compensationError, 'ExecutionTIMED_OUT');
  });

  it('saga recente, terminal ou com execução ainda rodando não muda', async () => {
    const recent = setup({ id: 'saga_c', status: 'RUNNING', updatedAt: ago(60 * 1000) }, { status: 'SUCCEEDED' });
    assert.strictEqual((await recent.service.getSaga('saga_c')).status, 'RUNNING');
    assert.strictEqual(recent.stepFunctions.described, 0);

    const done = setup({ id: 'saga_d', status: 'COMPLETED', updatedAt: ago(60 * 60 * 1000) }, { status: 'SUCCEEDED' });
    assert.strictEqual((await done.service.getSaga('saga_d')).status, 'COMPLETED');
    assert.strictEqual(done.stepFunctions.described, 0);

    const running = setup({ id: 'saga_e', status: 'RUNNING', updatedAt: ago(6 * 60 * 1000) }, { status: 'RUNNING' });
    assert.strictEqual((await running.service.getSaga('saga_e')).status, 'RUNNING');
  });

  it('Step Functions fora do ar não derruba a consulta', async () => {
    const { service } = setup({ id: 'saga_f', status: 'RUNNING', updatedAt: ago(6 * 60 * 1000) });
    assert.strictEqual((await service.getSaga('saga_f')).status, 'RUNNING');
  });

  it('não sobrescreve a saga que o workflow atualizou depois da leitura', async () => {
    const { db, service } = setup({ id: 'saga_g', status: 'RUNNING', updatedAt: ago(6 * 60 * 1000) }, { status: 'FAILED', error: 'SagaCompensated' });
    const read = structuredClone(db.tables.sagas.get('saga_g'));
    // O workflow gravou o status final entre a leitura e a correção
    Object.assign(db.tables.sagas.get('saga_g'), { status: 'COMPENSATED', updatedAt: ago(1000) });
    const result = await service.reconcile(read);
    assert.strictEqual(result.status, 'COMPENSATED');
    assert.strictEqual(db.tables.sagas.get('saga_g').reconciledFrom, undefined);
  });

  it('a varredura corrige só as paradas do último dia', async () => {
    const { db, service } = setup({ id: 'saga_h', status: 'RUNNING', updatedAt: ago(6 * 60 * 1000) }, { status: 'SUCCEEDED' });
    const recent = { id: 'saga_i', status: 'RUNNING', updatedAt: ago(1000), createdAt: ago(1000), productId: 'p1', quantity: 1, steps: {} };
    db.tables.sagas.set(recent.id, { ...recent, dayShard: sagaDayShard(recent.id, recent.createdAt) });

    assert.deepStrictEqual(await service.reconcileStuckSagas(), { checked: 1, reconciled: 1, stuck: 0 });
    assert.strictEqual(db.tables.sagas.get('saga_h').status, 'COMPLETED');
    assert.strictEqual(db.tables.sagas.get('saga_i').status, 'RUNNING');
    assert.ok(RECONCILE_MAX >= 1);
  });

  it('saga sem executionArn cuja execução nunca existiu vira START_FAILED e a mesma chave a reinicia', async () => {
    const key = 'never-started-key-0001';
    const id = sagaIdFromKey(key);
    const { db, stepFunctions, service } = setup({ id, status: 'RUNNING', updatedAt: ago(6 * 60 * 1000), executionArn: undefined, executionName: id, startAttempts: 1 });
    stepFunctions.describeExecution = async () => { throw Object.assign(new Error('nope'), { name: 'ExecutionDoesNotExist' }); };

    const saga = await service.getSaga(id);
    assert.deepStrictEqual([saga.status, saga.error], ['FAILED', 'StartExecutionFailed']);

    const { created } = await service.startSaga({ productId: 'p1', quantity: 1, idempotencyKey: key });
    assert.strictEqual(created, true);
    assert.strictEqual(db.tables.sagas.get(id).status, 'RUNNING');
    assert.strictEqual(stepFunctions.started.length, 1);
  });

  it('saga sem executionArn gravado é reconciliada pela execução procurada pelo nome', async () => {
    const { db, service } = setup({ id: 'saga_m', status: 'RUNNING', updatedAt: ago(6 * 60 * 1000), executionArn: undefined, executionName: 'saga_m' }, { status: 'SUCCEEDED' });
    assert.strictEqual((await service.getSaga('saga_m')).status, 'COMPLETED');
    assert.strictEqual(db.tables.sagas.get('saga_m').reconciledFrom, 'SUCCEEDED');
  });

  it('uma saga que falha não interrompe a varredura nem a métrica', async () => {
    const { db, service } = setup({ id: 'saga_n', status: 'RUNNING', updatedAt: ago(6 * 60 * 1000) }, { status: 'SUCCEEDED' });
    const broken = { id: 'saga_o', status: 'RUNNING', updatedAt: ago(8 * 60 * 1000), createdAt: ago(8 * 60 * 1000), productId: 'p1', quantity: 1, steps: {} };
    db.tables.sagas.set(broken.id, { ...broken, dayShard: sagaDayShard(broken.id, broken.createdAt) });
    const getItem = db.getItem.bind(db);
    db.getItem = async (table, key, options) => {
      if (key.id === 'saga_o') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      return getItem(table, key, options);
    };

    assert.deepStrictEqual(await service.reconcileStuckSagas(), { checked: 2, reconciled: 1, stuck: 1 });
    assert.strictEqual(db.tables.sagas.get('saga_n').status, 'COMPLETED');
  });

  // O alarme sagas-stuck lê esta métrica: publicada toda rodada, inclusive 0
  it('publica SagasStuck com as que a reconciliação não fechou (ex.: sem executionArn)', async () => {
    const { db, service } = setup({ id: 'saga_j', status: 'RUNNING', updatedAt: ago(6 * 60 * 1000) }, { status: 'SUCCEEDED' });
    const noArn = { id: 'saga_k', status: 'RUNNING', updatedAt: ago(7 * 60 * 1000), createdAt: ago(7 * 60 * 1000), productId: 'p1', quantity: 1, steps: {} };
    db.tables.sagas.set(noArn.id, { ...noArn, dayShard: sagaDayShard(noArn.id, noArn.createdAt) });

    const original = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    const lines = [];
    const log = console.log;
    console.log = line => lines.push(line);
    try {
      assert.deepStrictEqual(await service.reconcileStuckSagas(), { checked: 2, reconciled: 1, stuck: 1 });
    } finally {
      console.log = log;
      process.env.LOG_LEVEL = original;
    }
    const line = lines.map(l => JSON.parse(l)).find(l => l.event === 'SAGAS_STUCK_CHECKED');
    assert.deepStrictEqual([line.status, line.SagasStuck, line.BusinessErrors], ['info', 1, undefined]);
    assert.deepStrictEqual(line._aws.CloudWatchMetrics[0].Metrics.map(m => m.Name), ['SagasStuck']);
  });
});


describe('SagaService.recentSagas (GET /sagas?recent=)', () => {
  const NOW = Date.parse('2026-10-05T12:00:00Z');
  const put = (db, id, hoursAgo) => {
    const createdAt = new Date(NOW - hoursAgo * 3600 * 1000).toISOString();
    db.tables.sagas.set(id, { id, status: 'COMPLETED', productId: 'apple', quantity: 1, steps: { createOrder: { status: 'COMPLETED' } }, createdAt, updatedAt: createdAt, dayShard: sagaDayShard(id, createdAt), executionArn: 'arn:x' });
  };

  // Antes a tela Comprar seguia todas as páginas do Scan da tabela
  it('as mais recentes das últimas 24 h, pelo índice por dia, sem varrer a tabela', async () => {
    const db = new FakeDb();
    db.scanPage = async () => { throw new Error('não deveria varrer a tabela'); };
    for (const [id, hours] of [['saga_a', 1], ['saga_b', 3], ['saga_c', 2], ['saga_velha', 30]]) put(db, id, hours);
    const service = new SagaService({ db, stepFunctions: new FakeStepFunctions(), productClient: new FakeProductClient({}), now: () => NOW });

    const sagas = await service.recentSagas({ limit: 2 });
    assert.deepStrictEqual(sagas.map(s => s.id), ['saga_a', 'saga_c']);
    // Lida por inteiro (o índice só projeta status/updatedAt), com progresso e sem campos internos
    assert.strictEqual(sagas[0].productId, 'apple');
    assert.strictEqual(sagas[0].progress.completed, 1);
    assert.strictEqual('executionArn' in sagas[0], false);
    assert.deepStrictEqual((await service.recentSagas({ limit: 10 })).map(s => s.id), ['saga_a', 'saga_c', 'saga_b']);
  });

  it('limit fora de 1 a 50 é ValidationError', async () => {
    const service = new SagaService({ db: new FakeDb(), stepFunctions: new FakeStepFunctions(), productClient: new FakeProductClient({}), now: () => NOW });
    for (const limit of [0, 51, 2.5, NaN]) {
      await assert.rejects(service.recentSagas({ limit }), ValidationError, String(limit));
    }
  });
});
