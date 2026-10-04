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

function shouldLog(severity) {
  const level = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
  return level >= LEVELS[severity];
}

// Resolvido na chamada (não no carregamento) para os testes poderem trocar o console
const WRITERS = { error: 'error', warn: 'warn', info: 'log', debug: 'log' };

export function log({ event, orderId, correlationId, status, message, data = null, error = null }) {
  const severity = severityOf(status, error);
  if (!shouldLog(severity)) return;

  const logEntry = {
    timestamp: new Date().toISOString(),
    // As Lambdas dividem um log group; o nome da função identifica a origem
    service: process.env.AWS_LAMBDA_FUNCTION_NAME,
    event,
    orderId,
    correlationId,
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

  // Uma linha JSON por evento (formato lido pelo CloudWatch Logs Insights e
  // pelo metric filter de erros não tratados no template.yaml)
  console[WRITERS[severity]](JSON.stringify(logEntry));
}
