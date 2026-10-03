import { successResponse } from '../../../../common/response.mjs';
import { normalizeHttpEvent } from '../../../../common/http-event.mjs';

/**
 * Gateway centralizado.
 *
 * No HttpApi cada rota (/products, /orders, /payments, /stock, /saga...) é
 * ligada diretamente à Lambda do serviço. Esta função atende o health check e
 * tudo o que não casar com nenhuma rota ({proxy+}), devolvendo a lista de
 * endpoints disponíveis.
 */
const AVAILABLE_ENDPOINTS = [
  'GET  /health',
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

export async function handleAPIRequest(rawEvent) {
  const event = normalizeHttpEvent(rawEvent);

  if (event.path === '/health') {
    return successResponse({ status: 'healthy', timestamp: new Date().toISOString() });
  }

  return successResponse({
    error: 'Not found',
    message: `Endpoint ${event.httpMethod} ${event.path} not found`,
    available: AVAILABLE_ENDPOINTS
  }, 404);
}

// Handler referenciado pelo template SAM
export const handler = handleAPIRequest;
