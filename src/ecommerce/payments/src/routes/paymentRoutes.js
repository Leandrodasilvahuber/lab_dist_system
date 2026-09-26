import { PaymentController } from '../controllers/PaymentController.js';

export function setupRoutes(event, context) {
  const method = event.httpMethod;
  const path = event.path;
  const body = event.body ? JSON.parse(event.body) : null;

  // POST /payments
  if (method === 'POST' && path === '/payments') {
    return PaymentController.processPayment(event);
  }

  // POST /payments/refund
  if (method === 'POST' && path === '/payments/refund') {
    return PaymentController.refundPayment(event);
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