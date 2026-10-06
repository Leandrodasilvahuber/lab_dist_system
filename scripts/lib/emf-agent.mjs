import { PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DescribeLogGroupsCommand, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { extractEmfMetrics } from '../../src/common/emf.mjs';
import { parseLogLine } from '../../src/common/log-query.mjs';

// Limite do PutMetricData por chamada
const MAX_DATUMS = 1000;
// Na 1ª leitura as linhas antigas só vão para o buffer (Logs/Rastreio): publicar
// as métricas de novo dobraria a contagem a cada reinício do local-server.
// 24 h para a aba Logs não ficar vazia depois de um reinício enquanto a aba
// Métricas (guardada no CloudWatch do LocalStack) ainda mostra os erros do dia
export const BACKFILL_MS = 24 * 60 * 60 * 1000;

/**
 * Faz localmente o que o CloudWatch faz na AWS com o Embedded Metric Format:
 * o LocalStack guarda os logs mas não extrai as métricas do bloco `_aws`.
 *
 * - capture(entry): linhas do próprio processo (handlers rodando no local-server);
 * - poll(): linhas das Lambdas `local-*` publicadas no LocalStack (os passos da saga),
 *   lidas dos log groups /aws/lambda/local-*; cada linha também vai para onEntry
 *   (o buffer das abas Logs e Rastreio);
 * - flush(): publica as métricas acumuladas com PutMetricData, um ponto por
 *   série e minuto (aggregate).
 */
/**
 * Junta os pontos da mesma série (namespace, métrica, unidade e dimensões) no
 * mesmo minuto num só, com StatisticValues (SampleCount, Sum, Minimum, Maximum).
 * O resultado das consultas (Sum, Maximum, contagem) não muda, mas o CloudWatch
 * do LocalStack guarda um ponto por minuto em vez de um por linha de log: com um
 * ponto por linha, 290 mil pontos de uma rajada de 404 deixaram cada consulta
 * acima do timeout e o LocalStack com a CPU cheia.
 */
export function aggregate(data) {
  const series = new Map();
  for (const { Namespace, MetricName, Unit, Dimensions = [], Timestamp, Value } of data) {
    const minute = Math.floor(new Date(Timestamp).getTime() / 60000) * 60000;
    const key = JSON.stringify([Namespace, MetricName, Unit, Dimensions, minute]);
    const current = series.get(key);
    if (current) {
      const stats = current.StatisticValues;
      stats.SampleCount += 1;
      stats.Sum += Value;
      stats.Minimum = Math.min(stats.Minimum, Value);
      stats.Maximum = Math.max(stats.Maximum, Value);
    } else {
      series.set(key, {
        Namespace, MetricName, Unit, Dimensions, Timestamp: new Date(minute),
        StatisticValues: { SampleCount: 1, Sum: Value, Minimum: Value, Maximum: Value }
      });
    }
  }
  return [...series.values()];
}

export function createEmfAgent({ cloudwatch, logs, logGroupPrefix = '/aws/lambda/local-', onEntry = () => {}, now = Date.now }) {
  const pending = [];
  const cursors = new Map();
  const startedAt = now();
  let warned = false;

  const warnOnce = error => {
    if (warned) return;
    warned = true;
    console.warn(`⚠️  Agente EMF: LocalStack indisponível (${error.message}); métricas e logs das Lambdas locais ficam de fora até ele voltar.`);
  };

  function capture(entry, { publish = true } = {}) {
    if (publish) pending.push(...extractEmfMetrics(entry));
  }

  async function poll() {
    try {
      const { logGroups = [] } = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupPrefix }));
      for (const { logGroupName } of logGroups) await readGroup(logGroupName);
      warned = false;
    } catch (error) {
      warnOnce(error);
    }
  }

  // Lê a partir do último horário visto; o mesmo milissegundo pode voltar, por isso os ids
  async function readGroup(logGroupName) {
    const cursor = cursors.get(logGroupName) || { since: startedAt - BACKFILL_MS, seen: new Set() };
    let nextToken;
    let latest = cursor.since;
    const seen = new Set();
    try {
      do {
        const page = await logs.send(new FilterLogEventsCommand({ logGroupName, startTime: cursor.since, nextToken }));
        for (const { eventId, timestamp, message } of page.events || []) {
          seen.add(eventId);
          if (cursor.seen.has(eventId)) continue;
          latest = Math.max(latest, timestamp);
          const entry = parseLogLine(message);
          if (!entry) continue;
          onEntry(entry);
          capture(entry, { publish: timestamp >= startedAt });
        }
        nextToken = page.nextToken;
      } while (nextToken);
    } catch (error) {
      // Página que falhou no meio: as linhas já entregues não voltam na próxima
      // rodada (repetiriam na aba Logs e contariam duas vezes nas métricas). O
      // início fica o mesmo, porque o resto pode ter horários anteriores
      cursors.set(logGroupName, { since: cursor.since, seen: new Set([...cursor.seen, ...seen]) });
      throw error;
    }
    cursors.set(logGroupName, { since: latest, seen });
  }

  async function flush() {
    if (!pending.length) return;
    const byNamespace = new Map();
    for (const { Namespace, ...datum } of aggregate(pending.splice(0))) {
      if (!byNamespace.has(Namespace)) byNamespace.set(Namespace, []);
      byNamespace.get(Namespace).push(datum);
    }
    try {
      for (const [Namespace, data] of byNamespace) {
        for (let i = 0; i < data.length; i += MAX_DATUMS) {
          await cloudwatch.send(new PutMetricDataCommand({ Namespace, MetricData: data.slice(i, i + MAX_DATUMS) }));
        }
      }
    } catch (error) {
      warnOnce(error);
    }
  }

  function start(intervalMs = 10 * 1000) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await poll();
        await flush();
      } finally {
        running = false;
      }
    };
    tick();
    return setInterval(tick, intervalMs).unref();
  }

  return { capture, poll, flush, start };
}
