import { Database } from '../../../../common/database.mjs';
import { SAGAS_BY_DAY_INDEX, dayShardsInWindow } from '../../../../common/saga-day-index.mjs';
import { STUCK_AFTER_MS } from '../../../../common/saga-timing.mjs';
import { IS_LOCAL } from '../../../../common/aws-client.mjs';
import { parseHours } from '../../../../common/validation.mjs';
import { DlqClient } from './DlqClient.js';

// Metas dos SLOs (critério de sucesso dos testes de carga/caos). Os SLOs
// nativos do template.yaml (Application Signals) usam os mesmos valores.
// No LocalStack cada passo da compra pode subir um contêiner (p50 ~15 s):
// 2 s ficaria sempre violado. Lá a meta é 1 min, que ainda acusa compra
// anormalmente lenta; na AWS (IS_LOCAL falso) vale a de produção
export const PURCHASE_P95_MS = { aws: 2000, local: 60 * 1000 };
export const SLO_TARGETS = {
  purchaseP95Ms: IS_LOCAL ? PURCHASE_P95_MS.local : PURCHASE_P95_MS.aws,
  sagaSuccessRatio: 0.995,
  dlqMaxAgeHours: 24
};

export const SLO_CACHE_TTL_MS = 20 * 1000;
// Saga em RUNNING/COMPENSATING há mais que isso: provavelmente travada
export { STUCK_AFTER_MS };

const HOUR_MS = 60 * 60 * 1000;
const SUCCESS = ['COMPLETED', 'COMPENSATED'];
const TERMINAL = [...SUCCESS, 'FAILED', 'COMPENSATION_FAILED'];
const IN_PROGRESS = ['RUNNING', 'COMPENSATING'];

// Períodos do dashboard (PERIODS.short): limitam as chaves do cache (parseHours)
export const SLO_HOURS = [1, 24, 24 * 7];

export function parseSloQuery(query = {}) {
  return { hours: parseHours(query.hours, { allowed: SLO_HOURS }) };
}

/**
 * SLOs calculados na leitura, iguais no LocalStack e na AWS:
 *  - latência e desfecho das compras pela tabela de sagas (o Step Functions
 *    marca a saga compensada como FAILED, então só o `status` da tabela separa
 *    compensação de falha);
 *  - mensagens esquecidas na DLQ pelo SentTimestamp (tratar = reprocessar ou
 *    descartar, o que tira a mensagem da fila).
 * As sagas da janela vêm do SagasByDayIndex: uma Query por dia e shard, em
 * paralelo (24 h = 2 dias x 10 shards), sem varrer a tabela inteira.
 */
export class SloClient {
  constructor({ db = new Database(), dlq = new DlqClient(), cacheTtlMs = SLO_CACHE_TTL_MS, now = Date.now } = {}) {
    this.db = db;
    this.dlq = dlq;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cache = new Map();
  }

  // Mesma ideia do SagaMetricsClient: guarda a promessa, falha não fica no cache
  evaluate({ hours = 24 } = {}) {
    const cached = this.cache.get(hours);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const value = this.read(hours);
    this.cache.set(hours, { value, expiresAt: this.now() + this.cacheTtlMs });
    value.catch(() => { if (this.cache.get(hours)?.value === value) this.cache.delete(hours); });
    return value;
  }

  async read(hours) {
    const now = this.now();
    const since = now - hours * HOUR_MS;
    const [inWindow, dlq] = await Promise.all([this.sagasSince(since, now), this.dlq.listMessages()]);

    return {
      windowHours: hours,
      generatedAt: new Date(now).toISOString(),
      slos: [latencySlo(inWindow), outcomeSlo(inWindow, now), dlqSlo(dlq, now)]
    };
  }

  // O índice projeta só status e updatedAt, além das chaves (id, dayShard, createdAt)
  async sagasSince(sinceMs, nowMs) {
    const since = new Date(sinceMs).toISOString();
    const pages = await Promise.all(dayShardsInWindow(sinceMs, nowMs).map(dayShard =>
      this.db.queryItems('sagas', {
        IndexName: SAGAS_BY_DAY_INDEX,
        KeyConditionExpression: 'dayShard = :dayShard AND createdAt >= :since',
        ExpressionAttributeValues: { ':dayShard': dayShard, ':since': since }
      })
    ));
    return pages.flat();
  }
}

// Nearest-rank: o menor valor com pelo menos p% da amostra abaixo ou igual
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0)];
}

// Compra completa: da criação da saga ao MarkCompleted (updatedAt)
function latencySlo(sagas) {
  const durations = sagas
    .filter(saga => saga.status === 'COMPLETED')
    .map(saga => Date.parse(saga.updatedAt) - Date.parse(saga.createdAt))
    .filter(ms => Number.isFinite(ms) && ms >= 0);
  const p95 = percentile(durations, 95);
  return {
    id: 'purchase-latency',
    label: 'p95 da compra completa',
    target: SLO_TARGETS.purchaseP95Ms,
    unit: 'ms',
    value: p95,
    ok: p95 === null ? null : p95 < SLO_TARGETS.purchaseP95Ms,
    sample: durations.length,
    detail: { p50: percentile(durations, 50), p95, p99: percentile(durations, 99), max: durations.length ? Math.max(...durations) : null }
  };
}

function outcomeSlo(sagas, now) {
  const byStatus = Object.fromEntries([...TERMINAL, ...IN_PROGRESS].map(status => [status, 0]));
  for (const saga of sagas) {
    if (saga.status in byStatus) byStatus[saga.status]++;
  }
  const terminal = TERMINAL.reduce((sum, status) => sum + byStatus[status], 0);
  const good = SUCCESS.reduce((sum, status) => sum + byStatus[status], 0);
  const ratio = terminal ? good / terminal : null;
  const inProgress = sagas.filter(saga => IN_PROGRESS.includes(saga.status));
  return {
    id: 'saga-outcome',
    label: 'Sagas Completed ou Compensated',
    target: SLO_TARGETS.sagaSuccessRatio,
    unit: 'ratio',
    value: ratio,
    ok: ratio === null ? null : ratio >= SLO_TARGETS.sagaSuccessRatio,
    sample: terminal,
    detail: {
      byStatus,
      inProgress: inProgress.length,
      stuck: inProgress.filter(saga => now - Date.parse(saga.updatedAt || saga.createdAt) > STUCK_AFTER_MS).length
    }
  };
}

// O peek da DLQ vê até 50 mensagens: com mais que isso, o valor é um piso
function dlqSlo({ queue, approximateTotal, messages }, now) {
  const limitMs = SLO_TARGETS.dlqMaxAgeHours * HOUR_MS;
  const ages = messages.map(m => now - Date.parse(m.sentAt)).filter(Number.isFinite);
  const expired = ages.filter(age => age > limitMs).length;
  return {
    id: 'dlq-age',
    label: `Mensagens na DLQ há mais de ${SLO_TARGETS.dlqMaxAgeHours} h`,
    target: 0,
    unit: 'count',
    value: expired,
    ok: expired === 0,
    sample: approximateTotal,
    detail: {
      queue,
      total: approximateTotal,
      inspected: messages.length,
      partial: approximateTotal > messages.length,
      oldestAgeMs: ages.length ? Math.max(...ages) : null
    }
  };
}
