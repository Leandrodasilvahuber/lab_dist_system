import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { createServiceHandler } from '../../../src/common/http-handler.mjs';
import { successResponse, errorResponse } from '../../../src/common/response.mjs';

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
});
