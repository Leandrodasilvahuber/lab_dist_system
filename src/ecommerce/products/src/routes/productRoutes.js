import { ProductController } from '../controllers/ProductController.js';
import { notFoundResponse } from '../../../../common/response.mjs';

export async function setupRoutes(event) {
  const method = event.httpMethod;
  const path = event.path;
  const queryStringParameters = event.queryStringParameters || {};
  const idMatch = path.match(/^\/products\/([^/]+)$/);

  // GET /products
  if (method === 'GET' && path === '/products') {
    return ProductController.getProducts(event, queryStringParameters);
  }

  // GET /products/{id}
  if (method === 'GET' && idMatch) {
    return ProductController.getProducts(event, { id: decodeURIComponent(idMatch[1]) });
  }

  // POST /products
  if (method === 'POST' && path === '/products') {
    return ProductController.createProduct(event);
  }

  return notFoundResponse(path);
}
