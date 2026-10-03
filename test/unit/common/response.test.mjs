import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseBody, sdkErrorResponse } from '../../../src/common/response.mjs';
import {
  NotFoundError, InsufficientStockError, PaymentDeclinedError, ValidationError, InvalidStateError
} from '../../../src/common/errors.mjs';

describe('parseBody', () => {
  it('faz o parse de um objeto JSON', () => {
    assert.deepStrictEqual(parseBody({ body: '{"quantity":2}' }), { quantity: 2 });
  });

  it('retorna objeto vazio sem body', () => {
    assert.deepStrictEqual(parseBody({}), {});
  });

  for (const body of ['{invalid', '"texto"', '[1,2]', 'null']) {
    it(`rejeita ${body} com ValidationError`, () => {
      assert.throws(() => parseBody({ body }), ValidationError);
    });
  }
});

describe('sdkErrorResponse', () => {
  const cases = [
    [new ValidationError('x'), 400],
    [new NotFoundError('x'), 404],
    [new InvalidStateError('x'), 409],
    [new InsufficientStockError(), 409],
    [new PaymentDeclinedError(), 402],
    [new Error('boom'), 500]
  ];

  for (const [error, status] of cases) {
    it(`${error.name} -> ${status}`, () => {
      assert.strictEqual(sdkErrorResponse(error, 'fallback').statusCode, status);
    });
  }

  it('o name do erro de negócio vira o errorType da Lambda', () => {
    assert.strictEqual(new InsufficientStockError().name, 'InsufficientStock');
    assert.strictEqual(new PaymentDeclinedError().name, 'PaymentDeclined');
  });
});
