import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeHttpEvent, decodePathSegment } from '../../../src/common/http-event.mjs';
import { ValidationError } from '../../../src/common/errors.mjs';

describe('normalizeHttpEvent', () => {
  it('converte o payload 2.0 do HttpApi e remove o prefixo do stage', () => {
    const event = normalizeHttpEvent({
      version: '2.0',
      rawPath: '/dev/products/abc',
      requestContext: { stage: 'dev', http: { method: 'GET' } },
      headers: { 'X-Correlation-Id': 'corr-1', 'Idempotency-Key': 'k1' }
    });

    assert.strictEqual(event.method, 'GET');
    assert.strictEqual(event.path, '/products/abc');
    assert.strictEqual(event.headers['idempotency-key'], 'k1');
    assert.strictEqual(event.headers.correlationId, 'corr-1');
    assert.deepStrictEqual(event.queryStringParameters, {});
  });

  it('mantém o path no stage $default', () => {
    const event = normalizeHttpEvent({ rawPath: '/orders', requestContext: { stage: '$default', http: { method: 'POST' } } });
    assert.strictEqual(event.path, '/orders');
  });

  it('a raiz do stage nomeado (/dev, sem barra final) vira /', () => {
    const event = normalizeHttpEvent({ rawPath: '/dev', requestContext: { stage: 'dev', http: { method: 'GET' } } });
    assert.strictEqual(event.path, '/');
    // Só o prefixo exato: /devices não é o stage dev
    assert.strictEqual(normalizeHttpEvent({ rawPath: '/devices', requestContext: { stage: 'dev', http: { method: 'GET' } } }).path, '/devices');
  });

  it('decodePathSegment: encoding inválido é ValidationError (400), não URIError', () => {
    assert.strictEqual(decodePathSegment('prod%20a'), 'prod a');
    assert.throws(() => decodePathSegment('%E0'), ValidationError);
  });

  it('decodifica body em base64', () => {
    const event = normalizeHttpEvent({
      rawPath: '/orders',
      requestContext: { http: { method: 'POST' } },
      body: Buffer.from('{"a":1}').toString('base64'),
      isBase64Encoded: true
    });
    assert.strictEqual(event.body, '{"a":1}');
  });

  it('aceita headers ausentes', () => {
    const event = normalizeHttpEvent({ rawPath: '/x', requestContext: { http: { method: 'DELETE' } }, headers: null });
    assert.strictEqual(event.method, 'DELETE');
    assert.strictEqual(event.path, '/x');
    assert.strictEqual(event.headers.correlationId, undefined);
  });
});

describe('normalizeHttpEvent: correlationId do cliente', () => {
  const withHeader = value => normalizeHttpEvent({ rawPath: '/saga/execute', requestContext: { http: { method: 'POST' } }, headers: { 'X-Correlation-ID': value } });

  it('aceita ids com os caracteres do rastreio', () => {
    assert.strictEqual(withHeader('web-1.2:abc_9').headers.correlationId, 'web-1.2:abc_9');
  });

  // Gravado na saga, um valor desses faria GET /trace/{id} recusar o próprio id
  it('ignora valores que o rastreio recusaria', () => {
    for (const value of ['com espaço', 'a/b', 'x'.repeat(129), '']) {
      assert.strictEqual(withHeader(value).headers.correlationId, undefined, value.slice(0, 20));
    }
  });
});
