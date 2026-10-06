import { createHash } from 'node:crypto';
import { PurchaseLimitError } from '../../../../common/errors.mjs';
import { limitFromEnv, quotaDay } from '../../../../common/daily-quota.mjs';

// Teto padrão de compras novas por dia (DailyPurchaseLimit no template.yaml).
// 0 desliga o limite
export const DEFAULT_DAILY_PURCHASE_LIMIT = 150;
// Teto por cliente (IP de origem; DailyPurchaseLimitPerClient): sem ele, um
// script esgotaria o limite do dia para todos. 0 desliga
export const DEFAULT_DAILY_PURCHASE_LIMIT_PER_CLIENT = 20;

// Contadores na tabela de sagas: quota_AAAA-MM-DD (todas as compras do dia) e
// quota_AAAA-MM-DD_<hash do IP> (um cliente; o IP não é gravado). Sem dayShard
// nem createdAt: ficam fora do SagasByDayIndex e do backfill, listSagas/getSaga
// os ignoram pelo prefixo, e o TTL da tabela (expiresAt) os apaga
export const QUOTA_ID_PREFIX = 'quota_';
// Folga do TTL depois que o dia zera (o DynamoDB apaga em até ~48 h)
const EXPIRES_AFTER_RESET_S = 24 * 60 * 60;

export const isQuotaItem = item => String(item?.id).startsWith(QUOTA_ID_PREFIX);

// Dia da cota (vira às 12:00 de Brasília, daily-quota.mjs) e o id do contador dele
export function quotaWindow(nowMs) {
  const { day, resetsAtMs } = quotaDay(nowMs);
  return { id: `${QUOTA_ID_PREFIX}${day}`, resetsAtMs };
}

export function dailyPurchaseLimit(env = process.env) {
  return limitFromEnv(env.DAILY_PURCHASE_LIMIT, DEFAULT_DAILY_PURCHASE_LIMIT);
}

export function dailyPurchaseLimitPerClient(env = process.env) {
  return limitFromEnv(env.DAILY_PURCHASE_LIMIT_PER_CLIENT, DEFAULT_DAILY_PURCHASE_LIMIT_PER_CLIENT);
}

const clientHash = clientId => createHash('sha256').update(String(clientId)).digest('hex').slice(0, 16);

/**
 * Limites de compras novas por dia, para a conta ficar no orçamento: um para
 * todas as compras e um por cliente. Os contadores sobem na mesma transação
 * que grava a saga (SagaService.createSaga): compra que já existia (mesma
 * Idempotency-Key) não conta, e não há uma chamada a mais ao DynamoDB.
 */
export class PurchaseQuota {
  constructor({ limit = dailyPurchaseLimit(), perClientLimit = dailyPurchaseLimitPerClient(), now = Date.now } = {}) {
    this.limit = limit;
    this.perClientLimit = perClientLimit;
    this.now = now;
  }

  /**
   * Contadores que a compra precisa somar: [{ scope, limit, resetsAtMs, update }],
   * com `update` no formato do transactWrite. Vazio com os limites desligados.
   * `clientId`: IP de origem (sem ele, todos os clientes dividem um contador)
   */
  counters(clientId) {
    const { id, resetsAtMs } = quotaWindow(this.now());
    const expiresAt = Math.floor(resetsAtMs / 1000) + EXPIRES_AFTER_RESET_S;
    const counter = (scope, limit, counterId) => ({
      scope,
      limit,
      resetsAtMs,
      update: {
        table: 'sagas',
        Key: { id: counterId },
        UpdateExpression: 'ADD purchases :one SET expiresAt = :expiresAt',
        ConditionExpression: 'attribute_not_exists(purchases) OR purchases < :limit',
        ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':expiresAt': expiresAt }
      }
    });
    return [
      this.limit && counter('total', this.limit, id),
      this.perClientLimit && counter('client', this.perClientLimit, `${id}_${clientHash(clientId || 'unknown')}`)
    ].filter(Boolean);
  }

  // Contador cheio (a condição dele cancelou a transação): 429 até zerar
  limitError({ scope, limit, resetsAtMs }) {
    return new PurchaseLimitError(limit, {
      scope,
      resetsAt: new Date(resetsAtMs).toISOString(),
      retryAfterSeconds: Math.ceil((resetsAtMs - this.now()) / 1000)
    });
  }
}
