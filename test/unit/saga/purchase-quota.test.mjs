import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  PurchaseQuota, quotaWindow, dailyPurchaseLimit, dailyPurchaseLimitPerClient,
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
    assert.match(client.update.Key.id, /^quota_2026-10-06_[0-9a-f]{16}$/);
    assert.notStrictEqual(client.update.Key.id, quota.counters('198.51.100.7')[1].update.Key.id);
    assert.match(total.update.ConditionExpression, /purchases < :limit/);
    assert.deepStrictEqual(total.update.ExpressionAttributeValues,
      { ':one': 1, ':limit': 150, ':expiresAt': Date.parse('2026-10-08T15:00:00Z') / 1000 });
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
