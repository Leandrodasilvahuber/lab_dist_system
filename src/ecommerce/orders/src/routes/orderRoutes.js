import { OrderController } from '../controllers/OrderController.js';

export function setupRoutes(event, context) {
  const method = event.httpMethod;
  const path = event.path;
  const pathParameters = event.pathParameters;
  const queryStringParameters = event.queryStringParameters;
  const body = event.body ? JSON.parse(event.body) : null;

  // GET /orders
  if (method === 'GET' && path === '/orders') {
    return OrderController.getOrders(event, queryStringParameters);
  }

  // GET /orders/{id}
  if (method === 'GET' && pathParameters?.id) {
    return OrderController.getOrders(event, { id: pathParameters.id });
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