import { describe, it } from 'node:test';
import assert from 'node:assert';
import { webcrypto } from 'node:crypto';
import { newIdempotencyKey } from '../../../dashboard/js/core/ids.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('dashboard: Idempotency-Key', () => {
  it('usa crypto.randomUUID quando existe', () => {
    assert.strictEqual(newIdempotencyKey({ randomUUID: () => 'uuid-do-navegador' }), 'uuid-do-navegador');
  });

  // Página aberta por http://<ip da rede>: sem contexto seguro, sem randomUUID
  it('fora de contexto seguro, gera um UUID v4 com getRandomValues', () => {
    const insecure = { getRandomValues: array => webcrypto.getRandomValues(array) };
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey(insecure)));
    assert.strictEqual(keys.size, 50);
    for (const key of keys) assert.match(key, UUID_V4);
  });
});
