import { successResponse, errorResponse } from '../../../../common/response.mjs';
import { DomainError } from '../../../../common/errors.mjs';
import { normalizeHttpEvent } from '../../../../common/http-event.mjs';
import { log } from '../../../../common/logger.mjs';
import { AlarmsClient } from '../services/AlarmsClient.js';
import { LogsClient } from '../services/LogsClient.js';
import { DlqClient } from '../services/DlqClient.js';
import { parseLogQuery } from '../../../../common/log-query.mjs';

/**
 * Gateway centralizado.
 *
 * No HttpApi cada rota (/products, /orders, /payments, /stock, /saga...) é
 * ligada diretamente à Lambda do serviço. Esta função atende o health check,
 * os alarmes e os logs de erro (CloudWatch), a DLQ dos eventos de produto e
 * tudo o que não casar com nenhuma rota ({proxy+}), devolvendo a lista de
 * endpoints disponíveis.
 */
const AVAILABLE_ENDPOINTS = [
  'GET  /health',
  'GET  /alarms',
  'GET  /logs',
  'GET  /dlq',
  'POST /dlq/{messageId}/redrive',
  'POST /dlq/{messageId}/discard',
  'GET  /products',
  'POST /products',
  'GET  /products/{id}',
  'GET  /orders',
  'GET  /orders/{id}',
  'GET  /stock',
  'GET  /stock/{productId}',
  'POST /stock/{productId}/adjust',
  'POST /saga/execute',
  'GET  /saga/{sagaId}',
  'GET  /sagas'
];

export function createAPIHandler({ alarms = new AlarmsClient(), logs = new LogsClient(), dlq = new DlqClient() } = {}) {
  return async function handleAPIRequest(rawEvent) {
    const event = normalizeHttpEvent(rawEvent);

    if (event.path === '/health') {
      return successResponse({ status: 'healthy', timestamp: new Date().toISOString() });
    }

    if (event.method === 'GET' && event.path === '/alarms') {
      try {
        return successResponse({ alarms: await alarms.listAlarms() });
      } catch (error) {
        log({ event: 'ALARMS_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: 'Could not read CloudWatch alarms', error });
        return errorResponse('Alarms unavailable', 503);
      }
    }

    // Rota de admin: o authorizer do HttpApi exige a X-Api-Key antes de chegar aqui
    if (event.method === 'GET' && event.path === '/logs') {
      try {
        return successResponse({ logs: await logs.listLogs(parseLogQuery(event.queryStringParameters)) });
      } catch (error) {
        log({ event: 'LOGS_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: 'Could not read CloudWatch logs', error });
        return errorResponse('Logs unavailable', 503);
      }
    }

    // Rotas de admin (o body tem dados do produto e as ações mudam estado)
    if (event.method === 'GET' && event.path === '/dlq') {
      return dlqCall(event, 'list', async () => successResponse(await dlq.listMessages()));
    }
    const dlqAction = event.method === 'POST' && event.path.match(/^\/dlq\/([^/]+)\/(redrive|discard)$/);
    if (dlqAction) {
      const [, messageId, action] = dlqAction;
      return dlqCall(event, action, async () => {
        const entry = await (action === 'redrive' ? dlq.redrive(messageId) : dlq.discard(messageId));
        log({
          event: action === 'redrive' ? 'DLQ_REDRIVEN' : 'DLQ_DISCARDED',
          correlationId: event.headers.correlationId,
          status: 'info',
          message: `DLQ message ${messageId} ${action === 'redrive' ? 'redriven' : 'discarded'} (${entry.source}/${entry.detailType})`,
          data: { messageId, detailType: entry.detailType, productId: entry.detail?.productId }
        });
        return successResponse({ [action === 'redrive' ? 'redriven' : 'discarded']: messageId });
      });
    }

    return notFound(event);
  };
}

async function dlqCall(event, action, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DomainError) return errorResponse(error.message, error.statusCode);
    log({ event: 'DLQ_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: `DLQ ${action} failed`, error });
    return errorResponse('DLQ unavailable', 503);
  }
}

function notFound(event) {
  return successResponse({
    error: 'Not found',
    message: `Endpoint ${event.method} ${event.path} not found`,
    available: AVAILABLE_ENDPOINTS
  }, 404);
}

export const handleAPIRequest = createAPIHandler();

// Handler referenciado pelo template SAM
export const handler = handleAPIRequest;
