import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseBody, sdkErrorResponse } from '../../../src/common/response.mjs';
import {
  NotFoundError, InsufficientStockError, PaymentDeclinedError, ValidationError, InvalidStateError,
  DependencyUnavailableError, isRetryable
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

  it('dependência indisponível -> 503 com Retry-After', () => {
    const response = sdkErrorResponse(new DependencyUnavailableError('down', { retryAfterSeconds: 7 }), 'fallback');
    assert.strictEqual(response.statusCode, 503);
    assert.strictEqual(response.headers['Retry-After'], '7');
  });

  it('throttling, timeout e 5xx da AWS -> 503 com Retry-After; erro de requisição continua 500', () => {
    const awsError = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });
    for (const error of [
      awsError('ProvisionedThroughputExceededException'),
      awsError('TimeoutError'),
      awsError('Qualquer', { $retryable: { throttling: true } }),
      awsError('InternalServerError', { $metadata: { httpStatusCode: 500 } })
    ]) {
      const response = sdkErrorResponse(error, 'fallback');
      assert.strictEqual(response.statusCode, 503, error.name);
      assert.ok(response.headers['Retry-After']);
    }
    const missing = awsError('ResourceNotFoundException', { $metadata: { httpStatusCode: 400 } });
    assert.strictEqual(sdkErrorResponse(missing, 'fallback').statusCode, 500);
  });

  it('dependência indisponível: error com a causa; circuito aberto só info; já registrada não loga de novo', () => {
    const logged = [];
    const original = { log: console.log, error: console.error };
    const level = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    console.log = line => logged.push(JSON.parse(line));
    console.error = line => logged.push(JSON.parse(line));
    try {
      sdkErrorResponse(new DependencyUnavailableError('down', { cause: new Error('timeout') }), 'f', 'corr-1');
      sdkErrorResponse(new DependencyUnavailableError('circuit open'), 'f');
      sdkErrorResponse(new DependencyUnavailableError('down', { cause: new Error('x'), logged: true }), 'f');
    } finally {
      Object.assign(console, original);
      if (level === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = level;
    }
    assert.deepStrictEqual(logged.map(l => [l.event, l.status]), [
      ['DEPENDENCY_UNAVAILABLE', 'error'],
      ['DEPENDENCY_UNAVAILABLE', 'info']
    ]);
    assert.strictEqual(logged[0].correlationId, 'corr-1');
  });

  it('dependência indisponível é transitória (vale retry), erro de negócio não', () => {
    assert.strictEqual(isRetryable(new DependencyUnavailableError()), true);
    assert.strictEqual(isRetryable(new NotFoundError('x')), false);
  });

  it('o name do erro de negócio vira o errorType da Lambda', () => {
    assert.strictEqual(new InsufficientStockError().name, 'InsufficientStock');
    assert.strictEqual(new PaymentDeclinedError().name, 'PaymentDeclined');
  });
});
