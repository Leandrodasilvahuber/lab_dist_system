import { successResponse } from '../shared/response.mjs';
import { ProductSDK } from '../../../common/sdks/index.mjs';
import { OrderSDK } from '../../../common/sdks/index.mjs';
import { PaymentSDK } from '../../../common/sdks/index.mjs';
import { StockSDK } from '../../../common/sdks/index.mjs';

// EventBridge cliente - em produção usar AWS SDK
const eventBridgeClient = {
  publish: async (event) => {
    console.log('Event published:', event);
    return Promise.resolve();
  }
};

// Inicializar SDKs com EventBridge
const productSDK = new ProductSDK(eventBridgeClient);
const orderSDK = new OrderSDK(eventBridgeClient);
const paymentSDK = new PaymentSDK(eventBridgeClient);
const stockSDK = new StockSDK(eventBridgeClient);

export function handleAPIRequest(event) {
  console.log('API Request:', {
    method: event.httpMethod,
    path: event.path,
    body: event.body
  });

  try {
    // Roteamento principal
    const method = event.httpMethod;
    const path = event.path;

    // Health check
    if (path === '/health') {
      return successResponse({ status: 'healthy', timestamp: new Date().toISOString() });
    }

    // Rotas de produtos
    if (path === '/products' && method === 'GET') {
      return handleListProducts(event);
    }
    if (path === '/products' && method === 'POST') {
      return handleCreateProduct(event);
    }
    if (path.startsWith('/products/') && method === 'GET') {
      return handleGetProduct(event);
    }

    // Rotas de pedidos
    if (path === '/orders' && method === 'GET') {
      return handleListOrders(event);
    }
    if (path === '/orders' && method === 'POST') {
      return handleCreateOrder(event);
    }
    if (path.startsWith('/orders/') && method === 'GET') {
      return handleGetOrder(event);
    }

    // Rotas de saga
    if (path === '/saga/execute' && method === 'POST') {
      return handleExecuteSaga(event);
    }

    return {
      statusCode: 404,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Not found',
        message: `Endpoint ${path} not found`,
        available: [
          'GET /health',
          'GET /products',
          'POST /products',
          'GET /products/{id}',
          'GET /orders',
          'POST /orders',
          'GET /orders/{id}',
          'POST /saga/execute'
        ]
      })
    };

  } catch (error) {
    console.error('Error handling request:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: error.message
      })
    };
  }
}

// Handlers de produtos
async function handleCreateProduct(event) {
  const productData = JSON.parse(event.body);
  const product = await productSDK.createProduct(productData);
  return successResponse(product, 201);
}

async function handleGetProduct(event) {
  const productId = event.path.split('/').pop();
  const product = await productSDK.getProduct(productId);
  return successResponse(product);
}

async function handleListProducts(event) {
  const filters = event.queryStringParameters || {};
  const products = await productSDK.listProducts(filters);
  return successResponse({ products });
}

// Handlers de pedidos
async function handleCreateOrder(event) {
  const orderData = JSON.parse(event.body);
  const order = await orderSDK.createOrder(orderData);
  return successResponse(order, 201);
}

async function handleGetOrder(event) {
  const orderId = event.path.split('/').pop();
  const order = await orderSDK.getOrder(orderId);
  return successResponse(order);
}

async function handleListOrders(event) {
  const filters = event.queryStringParameters || {};
  const orders = await orderSDK.listOrders(filters);
  return successResponse({ orders });
}

// Handler de saga
async function handleExecuteSaga(event) {
  const sagaData = JSON.parse(event.body);

  // Saga de compra completa
  try {
    // 1. Criar pedido
    const order = await orderSDK.createOrder({
      productId: sagaData.productId,
      quantity: sagaData.quantity
    });

    // 2. Processar pagamento
    const payment = await paymentSDK.processPayment({
      orderId: order.id,
      amount: order.total,
      correlationId: sagaData.correlationId
    });

    // 3. Reservar estoque
    const stock = await stockSDK.reserveStock({
      productId: sagaData.productId,
      quantity: sagaData.quantity,
      correlationId: sagaData.correlationId
    });

    return successResponse({
      sagaId: 'saga_' + Date.now(),
      orderId: order.id,
      paymentId: payment.id,
      stockReservationId: stock.id,
      status: 'completed'
    });

  } catch (error) {
    console.error('Saga failed:', error);

    // Em produção: implementar rollback
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Saga execution failed',
        message: error.message,
        sagaId: 'saga_' + Date.now()
      })
    };
  }
}