import { describe, it } from 'node:test';
import assert from 'node:assert';
import { hashApiKey, isAdminRoute, isValidApiKey, isValidApiKeyHash } from '../../../src/common/auth.mjs';
import { createHandler, createKeyProvider, CACHE_TTL_MS } from '../../../src/layers/api-gateway-layer/src/auth/adminAuthorizer.js';

process.env.LOG_LEVEL = 'silent';

describe('rotas de admin', () => {
  it('protege as escritas, os logs e a DLQ', () => {
    assert.ok(isAdminRoute('POST', '/products'));
    assert.ok(isAdminRoute('POST', '/stock/p1/adjust'));
    assert.ok(isAdminRoute('GET', '/logs'));
    assert.ok(isAdminRoute('GET', '/dlq'));
    assert.ok(isAdminRoute('POST', '/dlq/m1/redrive'));
    assert.ok(isAdminRoute('POST', '/dlq/m1/discard'));
  });

  it('deixa públicas a vitrine, a compra e as consultas', () => {
    for (const [method, path] of [['GET', '/products'], ['GET', '/products/p1'], ['GET', '/stock'],
      ['POST', '/saga/execute'], ['GET', '/saga/s1'], ['GET', '/orders/o1'], ['GET', '/orders'], ['GET', '/sagas'], ['GET', '/health'], ['GET', '/alarms']]) {
      assert.ok(!isAdminRoute(method, path), `${method} ${path}`);
    }
  });

  it('o template.yaml aplica o authorizer exatamente nessas rotas', async () => {
    const fs = await import('node:fs');
    const template = fs.readFileSync(new URL('../../../template.yaml', import.meta.url), 'utf8');
    const protectedRoutes = [...template.matchAll(/Path: (\S+)\n\s+Method: (\S+)\n\s+Auth:\n\s+Authorizer: AdminApiKey/g)]
      .map(([, path, method]) => `${method} ${path}`).sort();
    assert.deepStrictEqual(protectedRoutes, ['GET /dlq', 'GET /logs', 'POST /dlq/{messageId}/{action}', 'POST /products', 'POST /stock/{productId}/adjust']);
  });
});

describe('X-Api-Key', () => {
  const key = 'chave-de-teste-bem-longa';

  it('aceita só a chave correta', () => {
    assert.ok(isValidApiKey({ 'x-api-key': key }, key));
    assert.ok(!isValidApiKey({ 'x-api-key': key + 'x' }, key));
    assert.ok(!isValidApiKey({}, key));
  });

  it('nega tudo se a chave esperada não estiver configurada', () => {
    assert.ok(!isValidApiKey({ 'x-api-key': '' }, ''));
    assert.ok(!isValidApiKey({ 'x-api-key': 'qualquer' }, undefined));
  });

  it('hash scrypt aceita só a chave correta', async () => {
    const hash = hashApiKey(key);
    assert.match(hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.ok(await isValidApiKeyHash({ 'x-api-key': key }, hash));
    assert.ok(!await isValidApiKeyHash({ 'x-api-key': key + 'x' }, hash));
    assert.ok(!await isValidApiKeyHash({ 'x-api-key': '' }, hash));
    assert.ok(!await isValidApiKeyHash({}, hash));
  });

  it('hash usa salt aleatório', () => {
    assert.notStrictEqual(hashApiKey(key), hashApiKey(key));
  });

  it('hash ausente ou mal formado nega tudo', async () => {
    const valid = hashApiKey(key);
    for (const stored of [undefined, '', key, 'scrypt$abc', `sha256$00$${'0'.repeat(64)}`, `scrypt$00$${'0'.repeat(10)}`,
      valid.replace(/\$[0-9a-f]{2}/, '$zz'), `${valid}$extra`]) {
      assert.ok(!await isValidApiKeyHash({ 'x-api-key': key }, stored), String(stored));
    }
  });

  it('authorizer do HttpApi responde no formato simples', async () => {
    const authorizer = createHandler(async () => key);
    assert.deepStrictEqual(await authorizer({ headers: { 'x-api-key': key } }), { isAuthorized: true });
    assert.deepStrictEqual(await authorizer({ headers: {} }), { isAuthorized: false });
  });

  it('authorizer nega se a chave não puder ser lida do SSM', async () => {
    const authorizer = createHandler(async () => { throw new Error('SSM fora'); });
    assert.deepStrictEqual(await authorizer({ headers: { 'x-api-key': key } }), { isAuthorized: false });
  });
});

describe('chave de admin no SSM', () => {
  const key = 'chave-de-teste-bem-longa';

  function fakeSsm() {
    const calls = [];
    return {
      calls,
      send: async command => { calls.push(command.input); return { Parameter: { Value: key } }; }
    };
  }

  it('lê o SecureString descriptografado e guarda em cache', async () => {
    const client = fakeSsm();
    const getKey = createKeyProvider({ parameterName: '/dev/ecommerce/admin-api-key', client, now: () => 0 });
    assert.strictEqual(await getKey(), key);
    assert.strictEqual(await getKey(), key);
    assert.deepStrictEqual(client.calls, [{ Name: '/dev/ecommerce/admin-api-key', WithDecryption: true }]);
  });

  it('relê depois que o cache expira', async () => {
    const client = fakeSsm();
    let time = 0;
    const getKey = createKeyProvider({ parameterName: '/p', client, now: () => time });
    await getKey();
    time = CACHE_TTL_MS + 1;
    await getKey();
    assert.strictEqual(client.calls.length, 2);
  });

  it('sem o nome do parâmetro configurado, falha (e o authorizer nega)', async () => {
    const getKey = createKeyProvider({ parameterName: undefined, client: fakeSsm() });
    await assert.rejects(getKey(), /ADMIN_API_KEY_PARAM/);
  });
});
