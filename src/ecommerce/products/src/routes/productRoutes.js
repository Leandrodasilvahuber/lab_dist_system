import { ProductController } from '../controllers/ProductController.js';

export function setupRoutes(event, context) {
  const method = event.httpMethod;
  const path = event.path;
  const pathParameters = event.pathParameters;
  const queryStringParameters = event.queryStringParameters;
  const body = event.body ? JSON.parse(event.body) : null;

  // GET /products
  if (method === 'GET' && path === '/products') {
    return ProductController.getProducts(event, queryStringParameters);
  }

  // GET /products/{id}
  if (method === 'GET' && pathParameters?.id) {
    return ProductController.getProducts(event, { id: pathParameters.id });
  }

  // POST /products
  if (method === 'POST' && path === '/products') {
    return ProductController.createProduct(event);
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