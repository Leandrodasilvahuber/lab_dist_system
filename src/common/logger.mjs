import { emfFields } from './emf.mjs';

// LOG_LEVEL: debug | info (padrão) | warn | error (só erros) | silent
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

// status 'warn' = erro tratado (regra de negócio); 'error' = erro não tratado;
// 'debug' = detalhe para investigação (só com LOG_LEVEL=debug).
// Com `error` e sem status explícito, o registro é tratado como 'error'.
function severityOf(status, error) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'error' || normalized === 'warn' || normalized === 'debug') return normalized;
  return error ? 'error' : 'info';
}

function currentLevel() {
  return LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
}

// Resolvido na chamada (não no carregamento) para os testes poderem trocar o console
const WRITERS = { error: 'error', warn: 'warn', info: 'log', debug: 'log' };

// Tipo do erro tratado sem objeto de erro (ex.: API_REJECTED, que só tem o status HTTP)
function errorTypeOf(error, data) {
  if (error) return error.name || 'Error';
  return data?.statusCode ? `HTTP_${data.statusCode}` : 'Rejected';
}

/**
 * Métricas EMF da linha: todo warn conta em BusinessErrors e todo error em
 * UnhandledErrors (total e por ErrorType), além das métricas pedidas em `metrics`
 * ({ metrics, dimensions, dimensionSets }, ver emf.mjs).
 */
function metricGroups(severity, error, data, metrics) {
  const groups = metrics ? [metrics] : [];
  if (severity === 'warn' || severity === 'error') {
    groups.push({
      metrics: { [severity === 'warn' ? 'BusinessErrors' : 'UnhandledErrors']: { value: 1 } },
      dimensions: { ErrorType: errorTypeOf(error, data) },
      dimensionSets: [[], ['ErrorType']]
    });
  }
  return groups;
}

/**
 * @typedef {object} LogEntry
 * @property {string} event
 * @property {string} [orderId]
 * @property {string} [correlationId]
 * @property {string} [status]
 * @property {string} [message]
 * @property {any} [data]
 * @property {any} [error]
 * @property {any} [metrics] grupo EMF ({ metrics, dimensions, dimensionSets }, ver emf.mjs)
 */

/** @param {LogEntry} entry */
export function log({ event, orderId, correlationId, status, message, data = null, error = null, metrics = null }) {
  const severity = severityOf(status, error);
  const level = currentLevel();
  if (level === LEVELS.silent) return;

  const timestamp = new Date();
  const metricFields = emfFields(metricGroups(severity, error, data, metrics), timestamp.getTime());
  const base = {
    timestamp: timestamp.toISOString(),
    // As Lambdas dividem um log group; o nome da função identifica a origem
    service: process.env.AWS_LAMBDA_FUNCTION_NAME,
    event,
    correlationId
  };

  // Abaixo do LOG_LEVEL a linha some, mas as métricas não: sai uma linha
  // mínima, sem status (a aba Logs a ignora), só para o CloudWatch extraí-las
  if (level < LEVELS[severity]) {
    if (metricFields._aws) console.log(JSON.stringify({ ...base, ...metricFields }));
    return;
  }

  /** @type {Record<string, any>} */
  const logEntry = {
    ...base,
    orderId,
    status: severity === 'info' ? (status || 'info') : severity,
    message,
    data,
    error: error ? error.message || String(error) : null
  };
  if (error) {
    logEntry.errorType = error.name || 'Error';
    // Stack só para erros não tratados: o tratado já é explicado pela mensagem
    if (severity === 'error' && error.stack) logEntry.stack = error.stack;
  }

  // Uma linha JSON por evento (formato lido pelo CloudWatch Logs Insights e,
  // pelo bloco _aws, pelo Embedded Metric Format do CloudWatch)
  console[WRITERS[severity]](JSON.stringify({ ...logEntry, ...metricFields }));
}
