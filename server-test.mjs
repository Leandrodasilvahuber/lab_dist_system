#!/usr/bin/env node

import http from 'http';

const PORT = 3001;
const server = http.createServer();

// Simular contexto da API Gateway
function createApiGatewayEvent(method, path, body = {}, pathParameters = {}) {
  return {
    httpMethod: method,
    path: path,
    requestContext: {
      requestId: `req-${Date.now()}`,
      identity: {
        apiKey: null,
        authorization: null
      }
    },
    headers: {
      'Content-Type': 'application/json'
    },
    queryStringParameters: {},
    pathParameters: pathParameters,
    body: typeof body === 'object' ? JSON.stringify(body) : body,
    isBase64Encoded: false
  };
}

// Controllers simulados
const healthHandler = (event) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    status: 'healthy',
    message: 'Distributed E-commerce System',
    timestamp: new Date().toISOString()
  })
});

const productHandlers = {
  GET: (event) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      id: 'prod-1',
      name: 'Test Product',
      price: 99.99,
      stock: 10
    }])
  }),
  POST: (event) => ({
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: `prod-${Date.now()}`,
      name: event.body.name || 'Test Product',
      price: event.body.price || 99.99,
      stock: event.body.stock || 10
    })
  })
};

const orderHandler = {
  POST: (event) => ({
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: `order-${Date.now()}`,
      productId: event.body.productId || 'prod-1',
      quantity: event.body.quantity || 1,
      userId: event.body.userId || 'user-123',
      status: 'CREATED'
    })
  })
};

const paymentHandler = {
  POST: (event) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId: event.body.orderId || 'order-123',
      amount: event.body.amount || 99.99,
      status: 'APPROVED',
      paymentId: `pay-${Date.now()}`
    })
  })
};

const stockHandler = {
  GET: () => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      productId: 'prod-1',
      available: 10,
      reserved: 0
    }])
  }),
  POST: (event) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId: event.pathParameters.orderId || 'order-123',
      productId: event.pathParameters.productId || 'prod-1',
      quantity: event.body.quantity || 1,
      status: 'RESERVED'
    })
  })
};

const sagaHandler = {
  POST: (event) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sagaId: `saga-${Date.now()}`,
      orderId: event.body.orderId || 'order-123',
      status: 'STARTED',
      steps: ['ORDER_CREATED', 'PAYMENT_APPROVED', 'STOCK_RESERVED', 'ORDER_COMPLETED']
    })
  })
};

// Router
const router = (req, res) => {
  const url = req.url;
  const method = req.method;

  // Parsear corpo
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const parsedBody = method === 'GET' ? {} : JSON.parse(body);
      const pathParts = url.split('/').filter(Boolean);
      const pathParameters = {};

      if (pathParts.length >= 2 && pathParts[0] === 'api' && pathParts[1] === 'ecommerce') {
        // Extrair path parameters
        if (pathParts.length > 3 && pathParts[3]) {
          pathParameters.productId = pathParts[3];
        }

        let responseData;

        // Health Check
        if (url === '/health' && method === 'GET') {
          responseData = healthHandler();
        }

        // Products: GET /api/ecommerce/products
        else if (url === '/api/ecommerce/products' && method === 'GET') {
          responseData = productHandlers.GET();
        }

        // Products: POST /api/ecommerce/products
        else if (url === '/api/ecommerce/products' && method === 'POST') {
          const event = createApiGatewayEvent(method, url, parsedBody);
          responseData = productHandlers.POST(event);
        }

        // Orders: POST /api/ecommerce/orders
        else if (url === '/api/ecommerce/orders' && method === 'POST') {
          const event = createApiGatewayEvent(method, url, parsedBody);
          responseData = orderHandler.POST(event);
        }

        // Payments: POST /api/ecommerce/payments
        else if (url === '/api/ecommerce/payments' && method === 'POST') {
          const event = createApiGatewayEvent(method, url, parsedBody);
          responseData = paymentHandler.POST(event);
        }

        // Stock: GET /api/ecommerce/stock
        else if (url === '/api/ecommerce/stock' && method === 'GET') {
          responseData = stockHandler.GET();
        }

        // Stock: POST /api/ecommerce/stock/:productId/reserve
        else if (url.match(/\/api\/ecommerce\/stock\/[^\/]+\/reserve$/) && method === 'POST') {
          const productId = url.split('/').pop();
          const event = createApiGatewayEvent(method, url, parsedBody, { productId });
          responseData = stockHandler.POST(event);
        }

        // Saga: POST /api/ecommerce/saga/orders
        else if (url === '/api/ecommerce/saga/orders' && method === 'POST') {
          const event = createApiGatewayEvent(method, url, parsedBody);
          responseData = sagaHandler.POST(event);
        }

        // 404
        else {
          responseData = {
            statusCode: 404,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              error: 'Not found',
              path: url,
              availableEndpoints: [
                'GET /health',
                'POST /api/ecommerce/products',
                'POST /api/ecommerce/orders',
                'POST /api/ecommerce/payments',
                'GET /api/ecommerce/stock',
                'POST /api/ecommerce/stock/:productId/reserve',
                'POST /api/ecommerce/saga/orders'
              ]
            })
          };
        }

        const response = responseData;
      } else {
        response = {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Not found', path: url })
        };
      }

      // Enviar resposta
      res.writeHead(response.statusCode, response.headers);
      res.end(response.body);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', message: error.message }));
    }
  });
};

server.on('request', router);

server.listen(PORT, () => {
  console.log(`🚀 Mock API Gateway em execução na porta ${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/health`);
  console.log(`🛒 API Gateway URL (formato): https://<api-id>.execute-api.<region>.amazonaws.com/${process.env.ENVIRONMENT || 'dev'}`);
  console.log('');
  console.log('Endpoints expostos pela API Gateway:');
  console.log(`  GET    /health`);
  console.log(`  POST   /api/ecommerce/products`);
  console.log(`  POST   /api/ecommerce/orders`);
  console.log(`  POST   /api/ecommerce/payments`);
  console.log(`  GET    /api/ecommerce/stock`);
  console.log(`  POST   /api/ecommerce/stock/:productId/reserve`);
  console.log(`  POST   /api/ecommerce/saga/orders`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});