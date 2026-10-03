import { OrderController } from '../controllers/OrderController.js';
import { notFoundResponse } from '../../../../common/response.mjs';

export async function setupRoutes(event) {
  const method = event.httpMethod;
  const path = event.path;
  const queryStringParameters = event.queryStringParameters || {};
  const idMatch = path.match(/^\/orders\/([^/]+)$/);

  // GET /orders
  if (method === 'GET' && path === '/orders') {
    return OrderController.getOrders(event, queryStringParameters);
  }

  // GET /orders/{id}
  if (method === 'GET' && idMatch) {
    return OrderController.getOrders(event, { id: decodeURIComponent(idMatch[1]) });
  }

  return notFoundResponse(path);
}
