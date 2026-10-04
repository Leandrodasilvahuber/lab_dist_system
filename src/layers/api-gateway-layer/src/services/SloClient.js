import { Database } from '../../../../common/database.mjs';
import { DlqClient } from './DlqClient.js';

// Metas dos SLOs (critério de sucesso dos testes de carga/caos). Os SLOs
// nativos do template.yaml (Application Signals) usam os mesmos valores.
export const SLO_TARGETS = {
  purchaseP95Ms: 2000,
  sagaSuccessRatio: 0.995,
  dlqMaxAgeHours: 24
};

export const SLO_CACHE_TTL_MS = 20 * 1000;
// Saga em RUNNING/COMPENSATING há mais que isso: provavelmente travada
export const STUCK_AFTER_MS = 5 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const SUCCESS = ['COMPLETED', 'COMPENSATED'];
const TERMINAL = [...SUCCESS, 'FAILED', 'COMPENSATION_FAILED'];
const IN_PROGRESS = ['RUNNING', 'COMPENSATING'];

export function parseSloQuery(query = {}) {
  const hours = Number(query.hours);
  return { hours: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 7) : 24 };
}

/**
 * SLOs calculados na leitura, iguais no LocalStack e na AWS:
 *  - latência e desfecho das compras pela tabela de sagas (o Step Functions
 *    marca a saga compensada como FAILED, então só o `status` da tabela separa
 *    compensação de falha);
 *  - mensagens esquecidas na DLQ pelo SentTimestamp (tratar = reprocessar ou
 *    descartar, o que tira a mensagem da fila).
 * A tabela de sagas não tem índice por data: a janela é filtrada após o Scan.
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
    const [sagas, dlq] = await Promise.all([this.db.scanItems('sagas'), this.dlq.listMessages()]);
    const since = now - hours * HOUR_MS;
    const inWindow = sagas.filter(saga => Date.parse(saga.createdAt) >= since);

    return {
      windowHours: hours,
      generatedAt: new Date(now).toISOString(),
      slos: [latencySlo(inWindow), outcomeSlo(inWindow, now), dlqSlo(dlq, now)]
    };
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
