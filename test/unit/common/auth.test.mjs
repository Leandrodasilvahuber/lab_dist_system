import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ADMIN_ROUTES, hashApiKey, isAdminRoute, isValidApiKey, isValidApiKeyHash } from '../../../src/common/auth.mjs';

process.env.LOG_LEVEL = 'silent';

describe('rotas de admin', () => {
  it('protege as escritas de admin (produto, estoque, ações da DLQ), o custo da conta, as métricas do CloudWatch, os logs e o rastreio', () => {
    assert.ok(isAdminRoute('POST', '/products'));
    assert.ok(isAdminRoute('DELETE', '/products/p1'));
    assert.ok(isAdminRoute('POST', '/stock/p1/adjust'));
    assert.ok(isAdminRoute('POST', '/dlq/m1/redrive'));
    assert.ok(isAdminRoute('POST', '/dlq/m1/discard'));
    assert.ok(isAdminRoute('GET', '/metrics/cost'));
    assert.ok(isAdminRoute('GET', '/metrics/errors'));
    assert.ok(isAdminRoute('GET', '/metrics/memory'));
    assert.ok(isAdminRoute('GET', '/logs'));
    assert.ok(isAdminRoute('GET', '/trace/s1'));
  });

  it('deixa público todo o resto: vitrine, compras, pedidos, métricas, a lista da DLQ, o caos e o reset da base', () => {
    for (const [method, path] of [['GET', '/products'], ['GET', '/products/p1'], ['GET', '/stock'],
      ['POST', '/saga/execute'], ['GET', '/saga/s1'], ['GET', '/sagas'], ['GET', '/orders'], ['GET', '/orders/o1'],
      ['GET', '/health'], ['GET', '/auth/config'], ['GET', '/alarms'], ['GET', '/metrics/sagas'],
      ['GET', '/metrics/slo'],
      ['GET', '/dlq'], ['POST', '/dlq/m1/other'], ['GET', '/chaos'], ['PUT', '/chaos'], ['DELETE', '/chaos'],
      ['GET', '/reset'], ['POST', '/reset']]) {
      assert.ok(!isAdminRoute(method, path), `${method} ${path}`);
    }
  });

  // O local-server usa ADMIN_ROUTES; na AWS vale o Auth de cada rota do template
  it('o template.yaml aplica o authorizer exatamente nas rotas de ADMIN_ROUTES', async () => {
    const fs = await import('node:fs');
    const template = fs.readFileSync(new URL('../../../template.yaml', import.meta.url), 'utf8');
    const routes = [...template.matchAll(/Path: (\S+)\n\s+Method: (\S+)(\n\s+Auth:\n\s+Authorizer: (\S+))?/g)]
      .map(([, path, method, , authorizer]) => ({ path, method, admin: authorizer === 'AdminJwt' }))
      .filter(route => !route.path.includes('{proxy+}'));
    assert.ok(routes.length > 10, 'rotas do template não encontradas');

    // Parâmetros do path viram um valor de exemplo: /stock/{productId}/adjust -> /stock/x/adjust
    const sample = path => path.replace(/\{(\w+)\}/g, (_, name) => (name === 'action' ? 'redrive' : 'x'));
    for (const route of routes) {
      assert.strictEqual(isAdminRoute(route.method, sample(route.path)), route.admin,
        `${route.method} ${route.path}: template ${route.admin ? 'exige' : 'não exige'} admin`);
    }
    // E toda rota de ADMIN_ROUTES está protegida no template
    for (const [method, pattern] of ADMIN_ROUTES) {
      assert.ok(routes.some(r => r.admin && r.method === method && pattern.test(sample(r.path))), `${method} ${pattern}`);
    }
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
});
