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
// quota_AAAA-MM-DD_<hash do cliente> (clientKey). Sem dayShard
// nem createdAt: ficam fora do SagasByDayIndex e do backfill, listSagas/getSaga
// os ignoram pelo prefixo, e o TTL da tabela (expiresAt) os apaga
export const QUOTA_ID_PREFIX = 'quota_';
// Folga do TTL depois que o dia zera (o DynamoDB apaga em até ~48 h)
const EXPIRES_AFTER_RESET_S = 24 * 60 * 60;
// Teto de contadores cheios lembrados por container (memória limitada)
const MAX_KNOWN_FULL = 10000;

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

/**
 * Quem conta como um cliente: o IPv4, ou o bloco /64 do IPv6 (cada conexão
 * doméstica recebe um /64 inteiro, e trocar de endereço dentro dele é
 * trivial). Clientes atrás do mesmo NAT dividem o limite: ele é configurável
 * (DailyPurchaseLimitPerClient).
 */
export function clientKey(ip) {
  const value = String(ip || 'unknown').trim().toLowerCase();
  // eslint-disable-next-line security/detect-unsafe-regex -- repetições limitadas ({1,3}, {3}), sem ReDoS
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  if (!value.includes(':')) return value;
  const [head, tail] = value.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map(g => g.padStart(4, '0')).join(':')}::/64`;
}

// 24 bits do SHA-256: o contador não identifica o cliente. Sem segredo, um
// hash inteiro do IPv4 seria revertido testando os 2^32 endereços; com 24
// bits cada contador corresponde a ~256 IPv4 possíveis. Dois clientes no
// mesmo contador (chance de ~0,07% ao dia com 150 clientes) só dividem o limite
const CLIENT_HASH_HEX = 6;
const clientHash = clientId => createHash('sha256').update(clientKey(clientId)).digest('hex').slice(0, CLIENT_HASH_HEX);

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
    // Contadores que já recusaram uma compra neste container. Só sobem no
    // dia (o id tem a data), então continuam cheios: a compra seguinte é
    // recusada sem consultar o produto nem tentar a transação, que também são
    // cobradas. Um limite novo exige deploy, que troca os containers
    this.full = new Set();
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
      this.perClientLimit && counter('client', this.perClientLimit, `${id}_${clientHash(clientId)}`)
    ].filter(Boolean);
  }

  // Contador desta compra que já se sabe cheio (markFull), ou undefined
  knownFull(clientId) {
    if (!this.full.size) return undefined;
    return this.counters(clientId).find(({ update }) => this.full.has(update.Key.id));
  }

  markFull({ update }) {
    // Só o dia atual interessa: os ids de dias anteriores saem
    const today = quotaWindow(this.now()).id;
    for (const id of this.full) if (!id.startsWith(today)) this.full.delete(id);
    if (this.full.size < MAX_KNOWN_FULL) this.full.add(update.Key.id);
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
