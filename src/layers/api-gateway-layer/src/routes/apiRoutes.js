import { successResponse, errorResponse } from '../../../../common/response.mjs';
import { normalizeHttpEvent } from '../../../../common/http-event.mjs';
import { log } from '../../../../common/logger.mjs';
import { AlarmsClient } from '../services/AlarmsClient.js';

/**
 * Gateway centralizado.
 *
 * No HttpApi cada rota (/products, /orders, /payments, /stock, /saga...) é
 * ligada diretamente à Lambda do serviço. Esta função atende o health check,
 * a lista de alarmes do CloudWatch e tudo o que não casar com nenhuma rota ({proxy+}), devolvendo a lista de
 * endpoints disponíveis.
 */
const AVAILABLE_ENDPOINTS = [
  'GET  /health',
  'GET  /alarms',
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

export function createAPIHandler({ alarms = new AlarmsClient() } = {}) {
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

    return notFound(event);
  };
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
