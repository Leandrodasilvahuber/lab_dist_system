import { randomUUID } from 'node:crypto';

// LOG_LEVEL: info (padrão) | error (só erros) | silent
const LEVELS = { silent: 0, error: 1, info: 2, debug: 2 };

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
    error: error ? error.message || error : null
  };

  // Uma linha JSON por evento (formato lido pelo CloudWatch Logs Insights)
  (isError ? console.error : console.log)(JSON.stringify(logEntry));
}

export function createLogContext(event, orderId = null, correlationId = null) {
  return {
    correlationId: correlationId || randomUUID(),
    orderId,
    event
  };
}

// Logger class wrapper for testing
export class Logger {
  constructor() {
    this.log = log;
  }

  event(correlationId, level, event) {
    log({
      event: {
        detail: event.detail,
        timestamp: new Date().toISOString()
      },
      correlationId,
      status: level.toUpperCase(),
      message: event.detail?.action || event.detail?.message || ''
    });
  }

  status(correlationId, action, status) {
    log({
      event: {
        detail: { action, status }
      },
      correlationId,
      status: status.toUpperCase()
    });
  }

  error(correlationId, action, error) {
    log({
      event: {
        detail: { action, error: error?.message || error }
      },
      correlationId,
      status: 'ERROR',
      message: error?.message || error
    });
  }

  trace(correlationId, action, callback) {
    try {
      const startTime = performance.now();
      callback();
      const duration = performance.now() - startTime;
      this.event(correlationId, 'info', {
        detail: { action, duration: `${Math.round(duration)}ms` }
      });
    } catch (error) {
      this.error(correlationId, action, error);
      throw error;
    }
  }
}