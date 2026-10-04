import { ProductController } from '../controllers/ProductController.js';
import { notFoundResponse } from '../../../../common/response.mjs';
import { decodePathSegment } from '../../../../common/http-event.mjs';

export async function setupRoutes(event) {
  const method = event.method;
  const path = event.path;
  const queryStringParameters = event.queryStringParameters || {};
  const idMatch = path.match(/^\/products\/([^/]+)$/);

  // GET /products
  if (method === 'GET' && path === '/products') {
    return ProductController.listProducts(event, queryStringParameters);
  }

  // GET /products/{id}
  if (method === 'GET' && idMatch) {
    return ProductController.getProduct(event, decodePathSegment(idMatch[1]));
  }

  // POST /products
  if (method === 'POST' && path === '/products') {
    return ProductController.createProduct(event);
  }

  return notFoundResponse(path);
}
