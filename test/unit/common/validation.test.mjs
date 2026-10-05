import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MAX_ID_LENGTH, requireId, toNumber } from '../../../src/common/validation.mjs';
import { ValidationError } from '../../../src/common/errors.mjs';
import { errorResponse, sdkErrorResponse, successResponse } from '../../../src/common/response.mjs';
import { createServiceHandler } from '../../../src/common/http-handler.mjs';

process.env.LOG_LEVEL = 'silent';

describe('toNumber', () => {
  it('aceita número e string numérica', () => {
    assert.strictEqual(toNumber(5), 5);
    assert.strictEqual(toNumber('2.5'), 2.5);
  });

  it('não converte boolean, null ou string vazia em número', () => {
    for (const value of [true, false, null, undefined, '', '  ', {}, []]) {
      assert.ok(Number.isNaN(toNumber(value)), JSON.stringify(value));
    }
  });
});

describe('respostas HTTP', () => {
  it('erro 500 não expõe detalhes internos', () => {
    const body = JSON.parse(sdkErrorResponse(new Error('senha do banco: xyz'), 'Falhou').body);
    assert.deepStrictEqual(body, { error: 'Falhou' });
    assert.deepStrictEqual(JSON.parse(errorResponse('x', 500).body), { error: 'x' });
  });

  it('CORS sem Allow-Credentials (inválido com origem *)', () => {
    assert.strictEqual(successResponse({}).headers['Access-Control-Allow-Credentials'], undefined);
  });
});

describe('createServiceHandler', () => {
  const http = (method, path) => ({ version: '2.0', rawPath: path, headers: {}, requestContext: { stage: '$default', http: { method } } });

  it('roteia ação, evento de domínio e HTTP', async () => {
    const handler = createServiceHandler({
      setupRoutes: async () => successResponse({ ok: true }),
      actions: { ping: () => 'pong' },
      eventHandlers: { 'products/ProductCreated': () => 'created' }
    });
    assert.strictEqual(await handler({ action: 'ping', input: {} }), 'pong');
    assert.strictEqual(await handler({ source: 'products', 'detail-type': 'ProductCreated', detail: {} }), 'created');
    assert.strictEqual((await handler(http('GET', '/x'))).statusCode, 200);
  });

  it('serviço sem rotas responde 404 a HTTP e exceção vira 500 genérico', async () => {
    assert.strictEqual((await createServiceHandler({ actions: {} })(http('GET', '/payments'))).statusCode, 404);
    const failing = createServiceHandler({ setupRoutes: async () => { throw new Error('boom'); } });
    const response = await failing(http('GET', '/x'));
    assert.strictEqual(response.statusCode, 500);
    assert.deepStrictEqual(JSON.parse(response.body), { error: 'Internal server error' });
  });
});

describe('requireId', () => {
  it('aceita string não vazia até MAX_ID_LENGTH', () => {
    assert.strictEqual(requireId('apple', 'productId'), 'apple');
    assert.strictEqual(requireId('x'.repeat(MAX_ID_LENGTH)), 'x'.repeat(MAX_ID_LENGTH));
  });

  // Acima de 2048 bytes a chave do DynamoDB daria ValidationException (500)
  it('recusa id vazio, de outro tipo ou longo demais com ValidationError', () => {
    for (const value of ['', undefined, null, 42, {}, 'x'.repeat(MAX_ID_LENGTH + 1)]) {
      assert.throws(() => requireId(value, 'productId'), ValidationError, JSON.stringify(value)?.slice(0, 20));
    }
  });
});
