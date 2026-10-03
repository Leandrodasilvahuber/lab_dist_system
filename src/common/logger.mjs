// LOG_LEVEL: debug | info (padrão) | error (só erros) | silent
const LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };

function shouldLog(isError) {
  const level = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
  return isError ? level >= LEVELS.error : level >= LEVELS.info;
}

export function log({ event, orderId, correlationId, status, message, data = null, error = null }) {
  const isError = Boolean(error) || String(status).toLowerCase() === 'error';
  if (!shouldLog(isError)) return;

  const logEntry = {
    timestamp: new Date().toISOString(),
    event,
    orderId,
    correlationId,
    status: status || 'info',
    message,
    data,
    error: error ? error.message || String(error) : null
  };

  // Uma linha JSON por evento (formato lido pelo CloudWatch Logs Insights)
  (isError ? console.error : console.log)(JSON.stringify(logEntry));
}
