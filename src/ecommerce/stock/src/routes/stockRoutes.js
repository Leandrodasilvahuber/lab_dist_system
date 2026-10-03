import { StockController } from '../controllers/StockController.js';
import { notFoundResponse } from '../../../../common/response.mjs';

export async function setupRoutes(event) {
  const method = event.httpMethod;
  const path = event.path;
  const queryStringParameters = event.queryStringParameters || {};
  const match = path.match(/^\/stock\/([^/]+)(?:\/(adjust))?$/);

  if (match) {
    event.pathParameters = { ...event.pathParameters, productId: decodeURIComponent(match[1]) };
  }

  // GET /stock
  if (method === 'GET' && path === '/stock') {
    return StockController.getStock(event, queryStringParameters);
  }

  // GET /stock/{productId}
  if (method === 'GET' && match && !match[2]) {
    return StockController.getStock(event);
  }

  // POST /stock/{productId}/adjust
  if (method === 'POST' && match?.[2] === 'adjust') {
    return StockController.adjustStock(event);
  }

  return notFoundResponse(path);
}
