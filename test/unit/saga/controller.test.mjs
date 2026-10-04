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
