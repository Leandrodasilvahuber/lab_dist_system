import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SagaOrchestratorController } from '../../../src/ecommerce/saga-orchestrator/src/controllers/SagaOrchestratorController.js';

const execute = headers => SagaOrchestratorController.executeSaga({
  headers,
  body: JSON.stringify({ productId: 'apple', quantity: 1 })
});

describe('POST /saga/execute', () => {
  it('sem Idempotency-Key responde 400 (um retry criaria outra compra)', async () => {
    const response = await execute({});
    assert.strictEqual(response.statusCode, 400);
    assert.match(JSON.parse(response.body).error, /Idempotency-Key/);
  });

  it('Idempotency-Key curta demais responde 400', async () => {
    assert.strictEqual((await execute({ 'idempotency-key': 'abc' })).statusCode, 400);
  });
});

describe('POST /saga/execute: quantity', () => {
  const withQuantity = quantity => SagaOrchestratorController.executeSaga({
    headers: { 'idempotency-key': '0b9a6f3e-quantidade-teste' },
    body: JSON.stringify({ productId: 'apple', quantity })
  });

  // Mesma regra das outras validações: número JSON, não texto
  it('quantity em texto responde 400', async () => {
    for (const quantity of ['2', '1', 'abc', true, null]) {
      const response = await withQuantity(quantity);
      assert.strictEqual(response.statusCode, 400, JSON.stringify(quantity));
    }
  });
});

describe('GET /sagas?recent=', () => {
  const list = recent => SagaOrchestratorController.getSagas({ headers: {}, queryStringParameters: { recent } });

  it('recent inválido responde 400 sem consultar o banco', async () => {
    for (const recent of ['0', '51', 'abc', '2.5', '']) {
      assert.strictEqual((await list(recent)).statusCode, 400, recent);
    }
  });
});
