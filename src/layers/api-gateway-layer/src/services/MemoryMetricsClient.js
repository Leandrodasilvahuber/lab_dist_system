import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { metricNamespace } from '../../../../common/emf.mjs';
import { awsClientConfig, QUERY_CLIENT_OPTIONS } from '../../../../common/aws-client.mjs';
import { CloudWatchMetricsClient, periodFor, ERROR_METRICS_CACHE_TTL_MS } from './CloudWatchMetricsClient.js';

// MemorySize das Lambdas (template.yaml, parâmetro FunctionMemoryMB)
export const functionMemoryMb = (env = process.env) => Number(env.FUNCTION_MEMORY_MB) || 256;

/**
 * Limite de memória da série: o MemorySize nas Lambdas (AWS e local-* no
 * LocalStack, criadas com o mesmo valor). O local-server é um processo Node
 * sem limite, então não há referência.
 */
export function memoryLimitFor(functionName, env = process.env) {
  return functionName === 'local-server' ? null : functionMemoryMb(env);
}

/**
 * Memória usada por função (MemoryUsedMB, gravada via EMF por
 * src/common/runtime-metrics.mjs) para a aba Recursos: máximo e média por
 * balde de tempo, mais o pico da janela. Reaproveita a descoberta de
 * dimensões e o GetMetricData do CloudWatchMetricsClient.
 */
export class MemoryMetricsClient {
  constructor({ namespace = metricNamespace(), client, cacheTtlMs = ERROR_METRICS_CACHE_TTL_MS, now = Date.now, env = process.env } = {}) {
    this.metrics = new CloudWatchMetricsClient({
      namespace,
      client: client || new CloudWatchClient(awsClientConfig('CLOUDWATCH_ENDPOINT', QUERY_CLIENT_OPTIONS)),
      now
    });
    this.namespace = namespace;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.env = env;
    this.cache = new Map();
  }

  memoryMetrics({ hours }) {
    const cached = this.cache.get(hours);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const value = this.readMemory(hours);
    this.cache.set(hours, { value, expiresAt: this.now() + this.cacheTtlMs });
    value.catch(() => { if (this.cache.get(hours)?.value === value) this.cache.delete(hours); });
    return value;
  }

  async readMemory(hours) {
    const period = periodFor(hours);
    const end = Math.ceil(this.now() / (period * 1000)) * period * 1000;
    const start = end - Math.ceil(hours * 3600 / period) * period * 1000;
    const buckets = [];
    for (let t = start; t < end; t += period * 1000) buckets.push(t);

    const names = await this.metrics.dimensionValues('MemoryUsedMB', ['FunctionName']);
    const query = (Id, Stat, FunctionName) => ({
      Id,
      ReturnData: true,
      MetricStat: {
        Metric: { Namespace: this.namespace, MetricName: 'MemoryUsedMB', Dimensions: [{ Name: 'FunctionName', Value: FunctionName }] },
        Period: period,
        Stat
      }
    });
    const results = await this.metrics.getMetricData(
      names.flatMap((name, i) => [query(`max_${i}`, 'Maximum', name), query(`avg_${i}`, 'Average', name)]),
      start, end
    );

    // Sem dado no balde = null (lacuna na linha), não 0 MB. O período da
    // consulta é o do balde, então em geral há um ponto por balde; se vierem
    // mais, `combine` junta (máximo dos máximos, média das médias)
    const series = (id, combine) => {
      const groups = buckets.map(() => []);
      const result = results.get(id);
      result?.timestamps.forEach((t, k) => {
        const index = Math.floor((t - start) / (period * 1000));
        if (index >= 0 && index < groups.length) groups[index].push(result.values[k]);
      });
      return groups.map(group => group.length ? combine(group) : null);
    };
    const maxOf = group => Math.max(...group);
    const meanOf = group => group.reduce((a, b) => a + b, 0) / group.length;
    const round = v => v === null ? null : Math.round(v * 10) / 10;

    return {
      hours,
      periodSeconds: period,
      buckets: buckets.map(t => new Date(t).toISOString()),
      functions: names
        .map((name, i) => {
          const max = series(`max_${i}`, maxOf).map(round);
          const avg = series(`avg_${i}`, meanOf).map(round);
          const points = max.filter(v => v !== null);
          return { name, limitMb: memoryLimitFor(name, this.env), max, avg, peak: points.length ? Math.max(...points) : null };
        })
        .filter(f => f.peak !== null)
        .sort((a, b) => a.name.localeCompare(b.name))
    };
  }
}
