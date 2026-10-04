import { OrderController } from '../controllers/OrderController.js';
import { notFoundResponse } from '../../../../common/response.mjs';
import { decodePathSegment } from '../../../../common/http-event.mjs';

export async function setupRoutes(event) {
  const method = event.method;
  const path = event.path;
  const queryStringParameters = event.queryStringParameters || {};
  const idMatch = path.match(/^\/orders\/([^/]+)$/);

  // GET /orders
  if (method === 'GET' && path === '/orders') {
    return OrderController.getOrders(event, queryStringParameters);
  }

  // GET /orders/{id}
  if (method === 'GET' && idMatch) {
    return OrderController.getOrders(event, { id: decodePathSegment(idMatch[1]) });
  }

  return notFoundResponse(path);
}
