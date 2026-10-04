import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { createServiceHandler } from '../../../src/common/http-handler.mjs';
import { successResponse, errorResponse } from '../../../src/common/response.mjs';
import { setupRoutes as productRoutes } from '../../../src/ecommerce/products/src/routes/productRoutes.js';

const request = path => ({ rawPath: path, requestContext: { http: { method: 'GET' } }, headers: {} });

describe('createServiceHandler: log por request', () => {
  const original = process.env.LOG_LEVEL;
  afterEach(() => {
    process.env.LOG_LEVEL = original;
    mock.restoreAll();
  });

  function run(response) {
    process.env.LOG_LEVEL = 'info';
    const out = mock.method(console, 'log', () => {});
    const warn = mock.method(console, 'warn', () => {});
    const handler = createServiceHandler({ setupRoutes: async () => response });
    return handler(request('/products')).then(() => ({
      out: out.mock.calls.map(c => JSON.parse(c.arguments[0])),
      warn: warn.mock.calls.map(c => JSON.parse(c.arguments[0]))
    }));
  }

  it('2xx gera uma linha info API_RESPONSE com método, path, status e duração', async () => {
    const { out, warn } = await run(successResponse({ ok: true }));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(warn.length, 0);
    assert.strictEqual(out[0].event, 'API_RESPONSE');
    assert.deepStrictEqual({ ...out[0].data, durationMs: typeof out[0].data.durationMs },
      { method: 'GET', path: '/products', statusCode: 200, durationMs: 'number' });
  });

  it('4xx gera uma linha warn API_REJECTED com a mensagem do erro', async () => {
    const { out, warn } = await run(errorResponse('price must be a positive number', 400));
    assert.strictEqual(out.length, 0);
    assert.strictEqual(warn[0].event, 'API_REJECTED');
    assert.match(warn[0].message, /400: price must be a positive number/);
  });

  // Path mal codificado não pode virar 500 nem contar no alarme de erros não tratados
  it('path com encoding inválido responde 400 e loga warn, sem linha error', async () => {
    process.env.LOG_LEVEL = 'info';
    mock.method(console, 'log', () => {});
    const warn = mock.method(console, 'warn', () => {});
    const error = mock.method(console, 'error', () => {});
    const response = await createServiceHandler({ setupRoutes: productRoutes })(request('/products/%E0'));

    assert.strictEqual(response.statusCode, 400);
    assert.deepStrictEqual(JSON.parse(response.body), { error: 'Invalid URL encoding in path' });
    assert.strictEqual(error.mock.calls.length, 0);
    assert.strictEqual(JSON.parse(warn.mock.calls[0].arguments[0]).event, 'API_REJECTED');
  });

  it('throttling da AWS lançado fora dos controllers responde 503 com Retry-After', async () => {
    process.env.LOG_LEVEL = 'info';
    mock.method(console, 'log', () => {});
    const error = mock.method(console, 'error', () => {});
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    const response = await createServiceHandler({ setupRoutes: async () => { throw throttled; } })(request('/products'));

    assert.strictEqual(response.statusCode, 503);
    assert.ok(Number(response.headers['Retry-After']) > 0);
    assert.strictEqual(JSON.parse(error.mock.calls[0].arguments[0]).event, 'DEPENDENCY_UNAVAILABLE');
  });
});
