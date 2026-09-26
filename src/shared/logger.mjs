import { v4 as uuidv4 } from 'uuid';

export function log({ event, orderId, correlationId, status, message, data = null, error = null }) {
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

  console.log(JSON.stringify(logEntry));

  if (error) {
    console.error(JSON.stringify({
      ...logEntry,
      level: 'error'
    }));
  }
}

export function createLogContext(event, orderId = null, correlationId = null) {
  return {
    correlationId: correlationId || uuidv4(),
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