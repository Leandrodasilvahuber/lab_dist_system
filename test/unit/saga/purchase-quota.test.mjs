import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  PurchaseQuota, quotaWindow, clientKey, dailyPurchaseLimit, dailyPurchaseLimitPerClient,
  DEFAULT_DAILY_PURCHASE_LIMIT, DEFAULT_DAILY_PURCHASE_LIMIT_PER_CLIENT
} from '../../../src/ecommerce/saga-orchestrator/src/services/PurchaseQuota.js';
import { PurchaseLimitError } from '../../../src/common/errors.mjs';

describe('PurchaseQuota', () => {
  it('o dia vira às 12:00 de Brasília (15:00 UTC)', () => {
    assert.deepStrictEqual(quotaWindow(Date.parse('2026-10-06T14:59:59Z')),
      { id: 'quota_2026-10-05', resetsAtMs: Date.parse('2026-10-06T15:00:00Z') });
    assert.deepStrictEqual(quotaWindow(Date.parse('2026-10-06T15:00:00Z')),
      { id: 'quota_2026-10-06', resetsAtMs: Date.parse('2026-10-07T15:00:00Z') });
    // Meia-noite UTC continua no dia que começou ao meio-dia anterior
    assert.strictEqual(quotaWindow(Date.parse('2026-10-07T00:30:00Z')).id, 'quota_2026-10-06');
  });

  it('counters: um ADD condicional por limite, com TTL um dia depois de zerar', () => {
    const now = Date.parse('2026-10-06T16:00:00Z');
    const quota = new PurchaseQuota({ limit: 150, perClientLimit: 20, now: () => now });
    const [total, client] = quota.counters('203.0.113.1');
    assert.deepStrictEqual([total.scope, total.limit, client.scope, client.limit], ['total', 150, 'client', 20]);
    assert.strictEqual(total.update.Key.id, 'quota_2026-10-06');
    // 24 bits do hash: o contador não identifica o IP
    assert.match(client.update.Key.id, /^quota_2026-10-06_[0-9a-f]{6}$/);
    assert.notStrictEqual(client.update.Key.id, quota.counters('198.51.100.7')[1].update.Key.id);
    assert.match(total.update.ConditionExpression, /purchases < :limit/);
    assert.deepStrictEqual(total.update.ExpressionAttributeValues,
      { ':one': 1, ':limit': 150, ':expiresAt': Date.parse('2026-10-08T15:00:00Z') / 1000 });
  });

  it('clientKey: IPv4 como está, IPv6 pelo bloco /64, IPv4 mapeado vira IPv4', () => {
    assert.strictEqual(clientKey('203.0.113.1'), '203.0.113.1');
    assert.strictEqual(clientKey('2001:db8:abcd:12:1:2:3:4'), '2001:0db8:abcd:0012::/64');
    assert.strictEqual(clientKey('2001:DB8:abcd:12::99'), '2001:0db8:abcd:0012::/64');
    assert.strictEqual(clientKey('2001:db8::1'), '2001:0db8:0000:0000::/64');
    assert.strictEqual(clientKey('::1'), '0000:0000:0000:0000::/64');
    assert.strictEqual(clientKey('::ffff:198.51.100.7'), '198.51.100.7');
    assert.strictEqual(clientKey(undefined), 'unknown');
    // Endereços do mesmo /64 dividem o contador
    const quota = new PurchaseQuota({ limit: 0, perClientLimit: 1, now: () => Date.parse('2026-10-06T16:00:00Z') });
    const id = ip => quota.counters(ip)[0].update.Key.id;
    assert.strictEqual(id('2001:db8:abcd:12::1'), id('2001:db8:abcd:12:ffff::2'));
    assert.notStrictEqual(id('2001:db8:abcd:12::1'), id('2001:db8:abcd:13::1'));
  });

  it('knownFull: lembra os contadores cheios do dia e esquece os de dias anteriores', () => {
    let now = Date.parse('2026-10-06T16:00:00Z');
    const quota = new PurchaseQuota({ limit: 10, perClientLimit: 2, now: () => now });
    assert.strictEqual(quota.knownFull('a'), undefined);
    quota.markFull(quota.counters('a')[1]);
    assert.strictEqual(quota.knownFull('a').scope, 'client');
    assert.strictEqual(quota.knownFull('b'), undefined);
    quota.markFull(quota.counters('b')[0]);
    assert.strictEqual(quota.knownFull('b').scope, 'total');
    // Dia seguinte: ids novos, nada cheio; o markFull limpa os antigos
    now = Date.parse('2026-10-07T15:00:00Z');
    assert.strictEqual(quota.knownFull('a'), undefined);
    quota.markFull(quota.counters('c')[1]);
    assert.strictEqual(quota.full.size, 1);
  });

  it('limites em 0: nenhum contador (a saga é gravada sem transação)', () => {
    assert.deepStrictEqual(new PurchaseQuota({ limit: 0, perClientLimit: 0 }).counters('x'), []);
    assert.deepStrictEqual(new PurchaseQuota({ limit: 0, perClientLimit: 3 }).counters('x').map(c => c.scope), ['client']);
  });

  it('limitError: 429 com escopo e Retry-After até zerar', () => {
    const now = Date.parse('2026-10-06T16:00:00Z');
    const quota = new PurchaseQuota({ limit: 3, perClientLimit: 1, now: () => now });
    const error = quota.limitError(quota.counters('x')[1]);
    assert.ok(error instanceof PurchaseLimitError);
    assert.deepStrictEqual([error.statusCode, error.scope, error.limit, error.resetsAt, error.retryAfterSeconds],
      [429, 'client', 1, '2026-10-07T15:00:00.000Z', 23 * 60 * 60]);
    assert.match(error.message, /per client/);
  });

  it('variáveis de ambiente: padrões 150 e 20, 0 desliga, valor inválido volta ao padrão', () => {
    assert.strictEqual(dailyPurchaseLimit({}), DEFAULT_DAILY_PURCHASE_LIMIT);
    assert.strictEqual(dailyPurchaseLimit({ DAILY_PURCHASE_LIMIT: '0' }), 0);
    assert.strictEqual(dailyPurchaseLimit({ DAILY_PURCHASE_LIMIT: 'abc' }), DEFAULT_DAILY_PURCHASE_LIMIT);
    assert.strictEqual(dailyPurchaseLimitPerClient({}), DEFAULT_DAILY_PURCHASE_LIMIT_PER_CLIENT);
    assert.strictEqual(dailyPurchaseLimitPerClient({ DAILY_PURCHASE_LIMIT_PER_CLIENT: '5' }), 5);
  });
});
