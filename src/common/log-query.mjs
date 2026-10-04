/**
 * Consulta das linhas de log de erro (warn/error) para a aba Logs do dashboard.
 * Mesmo formato na AWS (CloudWatch Logs) e no local-server (buffer em memória).
 */
export const MAX_LOG_ENTRIES = 200;

// level=error: só erros não tratados; qualquer outro valor: warn + error
export function parseLogQuery(query = {}) {
  const hours = Number(query.hours);
  return {
    levels: query.level === 'error' ? ['error'] : ['warn', 'error'],
    hours: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 14) : 24
  };
}

// Converte uma linha do logger (JSON) em entrada; ignora o que não for do logger
export function parseLogLine(line) {
  if (typeof line !== 'string' || !line.startsWith('{')) return null;
  try {
    const entry = JSON.parse(line);
    return entry && entry.event && entry.timestamp ? entry : null;
  } catch {
    return null;
  }
}

export function selectLogs(entries, { levels, hours }, now = Date.now()) {
  const since = now - hours * 3600 * 1000;
  return entries
    .filter(e => levels.includes(e.status) && Date.parse(e.timestamp) >= since)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_LOG_ENTRIES);
}

/**
 * Buffer circular das últimas linhas warn/error (usado pelo local-server, onde
 * os handlers rodam no mesmo processo e não há CloudWatch Logs).
 */
export function createLogBuffer(size = 500) {
  const entries = [];
  return {
    capture(line) {
      const entry = parseLogLine(line);
      if (!entry || (entry.status !== 'warn' && entry.status !== 'error')) return;
      entries.push(entry);
      if (entries.length > size) entries.shift();
    },
    query(query, now) {
      return selectLogs(entries, parseLogQuery(query), now);
    }
  };
}
