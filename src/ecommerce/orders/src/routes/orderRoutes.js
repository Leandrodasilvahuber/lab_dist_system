import { OrderController } from '../controllers/OrderController.js';

export async function setupRoutes(event) {
  const method = event.httpMethod;
  const path = event.path;
  const queryStringParameters = event.queryStringParameters || {};
  const idMatch = path.match(/^\/orders\/([^/]+)$/);

  // GET /orders
  if (method === 'GET' && path === '/orders') {
    return OrderController.getOrders(event, queryStringParameters);
  }

  // POST /orders
  if (method === 'POST' && path === '/orders') {
    return OrderController.createOrder(event);
  }

  // POST /orders/confirm
  if (method === 'POST' && path === '/orders/confirm') {
    return OrderController.confirmOrder(event);
  }

  // POST /orders/cancel
  if (method === 'POST' && path === '/orders/cancel') {
    return OrderController.cancelOrder(event);
  }

  // GET /orders/{id}
  if (method === 'GET' && idMatch) {
    return OrderController.getOrders(event, { id: decodeURIComponent(idMatch[1]) });
  }

  return {
    statusCode: 404,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({
      error: 'Not found',
      path: path
    })
  };
}
