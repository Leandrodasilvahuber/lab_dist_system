import { StockController } from '../controllers/StockController.js';

export function setupRoutes(event, context) {
  const method = event.httpMethod;
  const path = event.path;
  const pathParameters = event.pathParameters;
  const queryStringParameters = event.queryStringParameters;
  const body = event.body ? JSON.parse(event.body) : null;

  // GET /stock
  if (method === 'GET' && path === '/stock') {
    return StockController.getStock(event, queryStringParameters);
  }

  // GET /stock/{productId}
  if (method === 'GET' && pathParameters?.productId) {
    return StockController.getStock(event, { productId: pathParameters.productId });
  }

  // POST /stock/{productId}/reserve
  if (method === 'POST' && path.endsWith('/reserve')) {
    return StockController.reserveStock(event);
  }

  // POST /stock/{productId}/release
  if (method === 'POST' && path.endsWith('/release')) {
    return StockController.releaseStock(event);
  }

  // POST /stock/{productId}/adjust
  if (method === 'POST' && path.endsWith('/adjust')) {
    return StockController.adjustStock(event);
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