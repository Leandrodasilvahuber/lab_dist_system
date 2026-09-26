import health from './health.mjs';
import createProduct from './create-product.mjs';
import getOrder from './get-order.mjs';
import getProducts from './get-products.mjs';

export async function handler(event) {
  try {
    const { correlationId } = event.headers || {};

    log({
      event: 'API_REQUEST',
      correlationId,
      status: 'info',
      message: `Incoming request: ${event.httpMethod} ${event.path}`
    });

    const method = event.httpMethod;
    const path = event.path;
    const pathParameters = event.pathParameters;
    const body = event.body ? JSON.parse(event.body) : null;
    const queryStringParameters = event.queryStringParameters;

    // Route the request
    if (method === 'GET' && path === '/health') {
      return await health(event);
    }

    if (method === 'GET' && path === '/products') {
      return await getProducts(event, queryStringParameters);
    }

    if (method === 'GET' && pathParameters?.id) {
      return await getProducts(event, { id: pathParameters.id });
    }

    if (method === 'POST' && path === '/products') {
      return await createProduct(event);
    }

    if (method === 'GET' && path === '/orders') {
      return await getOrder(event, queryStringParameters);
    }

    if (method === 'GET' && pathParameters?.id) {
      return await getOrder(event, { id: pathParameters.id });
    }

    log({
      event: 'API_NOT_FOUND',
      correlationId,
      status: 'error',
      message: `Path not found: ${path}`,
      data: { method, path }
    });

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

  } catch (error) {
    log({
      event: 'API_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'API request error',
      error
    });

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Internal server error'
      })
    };
  }
}