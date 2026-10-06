import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { metricNamespace } from '../../../../common/emf.mjs';
import { awsClientConfig, QUERY_CLIENT_OPTIONS } from '../../../../common/aws-client.mjs';
import { parseHours } from '../../../../common/validation.mjs';

// Mesma ideia do SagaMetricsClient: aba aberta em vários navegadores não
// multiplica as leituras. O GetMetricData é cobrado por métrica pedida (a aba
// Métricas pede ~100) e a rota é pública: janelas de 24 h ou mais, em que um
// minuto a mais quase não muda o gráfico, ficam mais tempo no cache
export const ERROR_METRICS_CACHE_TTL_MS = 60 * 1000;
export const LONG_WINDOW_CACHE_TTL_MS = 5 * 60 * 1000;
export const cacheTtlFor = (hours, ttlMs) => hours >= 24 ? Math.max(ttlMs, LONG_WINDOW_CACHE_TTL_MS) : ttlMs;

// Resolução do gráfico conforme o período (até ~180 barras; o CloudWatch guarda 1 min por 15 dias)
export function periodFor(hours) {
  if (hours <= 3) return 60;
  if (hours <= 24) return 900;
  return 3600;
}

// Períodos do dashboard (PERIODS.metrics) e 14 dias (retenção de 1 min do
// CloudWatch: 15 dias). Também vale para /metrics/memory (MemoryMetricsClient)
export const METRICS_HOURS = [1, 3, 24, 24 * 7, 24 * 14];

// summary=1 (indicador do Monitoramento): só os totais e os tipos de erro de
// negócio, sem as ~90 consultas por ação da aba Métricas
export function parseMetricsQuery(query = {}) {
  return {
    hours: parseHours(query.hours, { allowed: METRICS_HOURS }),
    ...(query.summary === '1' && { summary: true })
  };
}

const OUTCOMES = ['ok', 'rejected', 'failed'];

/**
 * Séries das métricas gravadas via EMF (src/common/logger.mjs e actions.mjs)
 * para a aba Métricas: erros de negócio e não tratados por ErrorType e
 * chamadas/duração por ação da saga. ListMetrics descobre quais ErrorType e
 * Action existem (métricas com dado nas últimas 2 semanas) e GetMetricData lê
 * tudo numa consulta só.
 */
export class CloudWatchMetricsClient {
  constructor({ namespace = metricNamespace(), client, cacheTtlMs = ERROR_METRICS_CACHE_TTL_MS, now = Date.now } = {}) {
    this.namespace = namespace;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cache = new Map();
    this.client = client || new CloudWatchClient(awsClientConfig('CLOUDWATCH_ENDPOINT', QUERY_CLIENT_OPTIONS));
  }

  errorMetrics({ hours, summary = false }) {
    const key = `${hours}:${summary ? 'summary' : 'full'}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const value = this.readMetrics(hours, { summary });
    this.cache.set(key, { value, expiresAt: this.now() + cacheTtlFor(hours, this.cacheTtlMs) });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    return value;
  }

  async readMetrics(hours, { summary = false } = {}) {
    const period = periodFor(hours);
    const end = Math.ceil(this.now() / (period * 1000)) * period * 1000;
    const start = end - Math.ceil(hours * 3600 / period) * period * 1000;
    const buckets = [];
    for (let t = start; t < end; t += period * 1000) buckets.push(t);

    const [businessTypes, unhandledTypes, actions] = await Promise.all([
      this.dimensionValues('BusinessErrors', ['ErrorType']),
      summary ? [] : this.dimensionValues('UnhandledErrors', ['ErrorType']),
      summary ? [] : this.dimensionValues('ActionCount', ['Action', 'Outcome'])
    ]);

    const metricQuery = (Id, MetricName, Stat, dims, Period) => ({
      Id,
      ReturnData: true,
      MetricStat: {
        Metric: { Namespace: this.namespace, MetricName, Dimensions: Object.entries(dims).map(([Name, Value]) => ({ Name, Value })) },
        Period,
        Stat
      }
    });
    // Erros: série no tempo (gráfico). Poucas consultas: total + uma por ErrorType.
    // ClientErrors (leitura com 404, http-handler.mjs) só no total: fora dos alarmes,
    // mostra um cliente consultando o que não existe sem virar erro de negócio
    const seriesQueries = [
      metricQuery('business', 'BusinessErrors', 'Sum', {}, period),
      metricQuery('unhandled', 'UnhandledErrors', 'Sum', {}, period),
      metricQuery('client', 'ClientErrors', 'Sum', {}, period),
      ...businessTypes.map((type, i) => metricQuery(`business_${i}`, 'BusinessErrors', 'Sum', { ErrorType: type }, period)),
      ...unhandledTypes.map((type, i) => metricQuery(`unhandled_${i}`, 'UnhandledErrors', 'Sum', { ErrorType: type }, period))
    ];
    // Ações: só totais da janela, então um período do tamanho dela (1 ponto por
    // consulta), o que mantém barata a leitura de 9 consultas por ação
    const windowPeriod = (end - start) / 1000;
    const totalQueries = actions.flatMap((action, i) => OUTCOMES.flatMap(outcome => {
      const dims = { Action: action, Outcome: outcome };
      return [
        metricQuery(`calls_${i}_${outcome}`, 'ActionCount', 'Sum', dims, windowPeriod),
        metricQuery(`duration_${i}_${outcome}`, 'ActionDuration', 'Sum', dims, windowPeriod),
        metricQuery(`max_${i}_${outcome}`, 'ActionDuration', 'Maximum', dims, windowPeriod)
      ];
    }));

    const [results, totals] = await Promise.all([
      this.getMetricData(seriesQueries, start, end),
      this.getMetricData(totalQueries, start, end)
    ]);
    const series = id => align(results.get(id), buckets, period);
    const sum = id => series(id).reduce((a, b) => a + b, 0);
    const total = id => (totals.get(id)?.values || []).reduce((a, b) => a + b, 0);
    const byType = (prefix, types) => types
      .map((errorType, i) => ({ errorType, values: series(`${prefix}_${i}`) }))
      .map(s => ({ ...s, total: s.values.reduce((a, b) => a + b, 0) }))
      .filter(s => s.total > 0)
      .sort((a, b) => b.total - a.total);

    return {
      hours,
      // Resumo: sem tipos de erro não tratado nem ações (vazios, não zerados)
      ...(summary && { summary: true }),
      periodSeconds: period,
      buckets: buckets.map(t => new Date(t).toISOString()),
      business: { total: sum('business'), values: series('business'), byType: byType('business', businessTypes) },
      unhandled: { total: sum('unhandled'), values: series('unhandled'), byType: byType('unhandled', unhandledTypes) },
      client: { total: sum('client') },
      actions: actions
        .map((action, i) => {
          const byOutcome = Object.fromEntries(OUTCOMES.map(o => [o, total(`calls_${i}_${o}`)]));
          const calls = OUTCOMES.reduce((acc, o) => acc + byOutcome[o], 0);
          const duration = OUTCOMES.reduce((acc, o) => acc + total(`duration_${i}_${o}`), 0);
          const maxima = OUTCOMES.flatMap(o => totals.get(`max_${i}_${o}`)?.values || []);
          return {
            action,
            calls,
            ...byOutcome,
            avgMs: calls ? Math.round(duration / calls) : null,
            maxMs: maxima.length ? Math.max(...maxima) : null
          };
        })
        .filter(a => a.calls > 0)
        .sort((a, b) => b.calls - a.calls)
    };
  }

  // Valores da 1ª dimensão nas séries com exatamente esse conjunto de dimensões
  async dimensionValues(MetricName, dimensionSet) {
    const values = new Set();
    let NextToken;
    do {
      const page = await this.client.send(new ListMetricsCommand({ Namespace: this.namespace, MetricName, NextToken }));
      for (const { Dimensions = [] } of page.Metrics || []) {
        const names = Dimensions.map(d => d.Name);
        if (names.length === dimensionSet.length && dimensionSet.every(name => names.includes(name))) {
          values.add(Dimensions.find(d => d.Name === dimensionSet[0]).Value);
        }
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return [...values].sort();
  }

  async getMetricData(queries, start, end) {
    const results = new Map();
    if (!queries.length) return results;
    // Limite de 500 consultas por chamada
    for (let i = 0; i < queries.length; i += 500) {
      let NextToken;
      do {
        const page = await this.client.send(new GetMetricDataCommand({
          MetricDataQueries: queries.slice(i, i + 500),
          StartTime: new Date(start),
          EndTime: new Date(end),
          NextToken
        }));
        for (const { Id, Timestamps = [], Values = [] } of page.MetricDataResults || []) {
          const current = results.get(Id) || { timestamps: [], values: [] };
          current.timestamps.push(...Timestamps.map(t => new Date(t).getTime()));
          current.values.push(...Values);
          results.set(Id, current);
        }
        NextToken = page.NextToken;
      } while (NextToken);
    }
    return results;
  }
}

// Coloca os pontos do CloudWatch nos baldes do gráfico; sem dado = 0
export function align(result, buckets, period) {
  const values = buckets.map(() => 0);
  if (!result) return values;
  const first = buckets[0];
  result.timestamps.forEach((t, i) => {
    const index = Math.floor((t - first) / (period * 1000));
    if (index >= 0 && index < values.length) values[index] += result.values[i];
  });
  return values;
}
