/**
 * Consulta das linhas de log para as abas Logs (warn/error) e Rastreio (todas
 * as linhas de uma compra) do dashboard.
 * Mesmo formato na AWS (CloudWatch Logs) e no local-server (buffer em memória).
 */
export const MAX_LOG_ENTRIES = 200;
export const MAX_TRACE_ENTRIES = 500;

// Ids gerados pelo sistema (saga_<uuid>, order_saga_..., correlationId de header):
// restringe os caracteres porque o id entra no filter pattern do CloudWatch
const TRACE_ID = /^[\w.:-]{1,128}$/;

export function isTraceId(id) {
  return typeof id === 'string' && TRACE_ID.test(id);
}

// level=error: só erros não tratados; qualquer outro valor: warn + error
export function parseLogQuery(query = {}) {
  const hours = Number(query.hours);
  return {
    levels: query.level === 'error' ? ['error'] : ['warn', 'error'],
    hours: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 14) : 24
  };
}

/**
 * Converte uma linha do logger (JSON) em entrada; ignora o que não for do logger.
 * Com LogFormat Text o runtime da Lambda põe "<data>\t<requestId>\tINFO\t" antes
 * do JSON, então a leitura começa na primeira chave.
 */
export function parseLogLine(line) {
  if (typeof line !== 'string') return null;
  const start = line.indexOf('{');
  if (start === -1) return null;
  try {
    const entry = JSON.parse(line.slice(start));
    return entry && entry.event && entry.timestamp ? entry : null;
  } catch {
    return null;
  }
}

// Campos do EMF (_aws e valores na raiz) não interessam a quem lê o log
export function withoutMetrics(entry) {
  const directives = entry._aws?.CloudWatchMetrics;
  if (!directives) return entry;
  const omit = new Set(['_aws']);
  for (const { Dimensions = [], Metrics = [] } of directives) {
    Dimensions.flat().forEach(name => omit.add(name));
    Metrics.forEach(({ Name }) => omit.add(Name));
  }
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !omit.has(key)));
}

export function selectLogs(entries, { levels, hours }, now = Date.now()) {
  const since = now - hours * 3600 * 1000;
  return entries
    .filter(e => levels.includes(e.status) && Date.parse(e.timestamp) >= since)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_LOG_ENTRIES)
    .map(withoutMetrics);
}

// Linhas de uma compra, da mais antiga para a mais nova. Sem status = linha só
// de métricas (logger abaixo do LOG_LEVEL), que não conta nada a quem lê.
export function selectTrace(entries, correlationId) {
  return entries
    .filter(e => e.status && e.correlationId === correlationId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(0, MAX_TRACE_ENTRIES)
    .map(withoutMetrics);
}

/**
 * Buffer circular das últimas linhas do logger (usado pelo local-server, onde
 * não há CloudWatch Logs): warn/error para a aba Logs e qualquer linha com
 * correlationId para o Rastreio.
 */
export function createLogBuffer(size = 1000) {
  const entries = [];
  return {
    capture(line) {
      const entry = typeof line === 'string' ? parseLogLine(line) : line;
      if (!entry || !entry.status) return;
      if (entry.status !== 'warn' && entry.status !== 'error' && !entry.correlationId) return;
      entries.push(entry);
      if (entries.length > size) entries.shift();
    },
    query(query, now) {
      return selectLogs(entries, parseLogQuery(query), now);
    },
    trace(correlationId) {
      return selectTrace(entries, correlationId);
    }
  };
}
