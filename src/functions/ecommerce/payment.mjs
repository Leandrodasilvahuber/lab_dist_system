import { getItem, putItem, updateItem } from '../../shared/database.mjs';
import { successResponse, errorResponse } from '../../shared/response.mjs';
import { log, createLogContext } from '../../shared/logger.mjs';

export async function handler(event) {
  try {
    const { correlationId, idempotencyKey } = event.headers || {};
    const { orderId, amount } = JSON.parse(event.body);

    if (!orderId || !amount) {
      log({
        event: 'PAYMENT_VALIDATION_ERROR',
        correlationId,
        status: 'error',
        message: 'Missing required fields',
        data: { orderId, amount }
      });

      return errorResponse('Missing required fields: orderId, amount', 400);
    }

    log({
      event: 'PAYMENT_START',
      orderId,
      correlationId,
      status: 'info',
      message: 'Starting payment processing',
      data: { orderId, amount }
    });

    // Check if order exists
    const order = await getItem('orders', { id: orderId });
    if (!order) {
      log({
        event: 'PAYMENT_ORDER_NOT_FOUND',
        orderId,
        correlationId,
        status: 'error',
        message: 'Order not found',
        data: { orderId }
      });

      return errorResponse('Order not found', 404);
    }

    if (order.status !== 'STARTED' && order.status !== 'ORDER_CREATED') {
      log({
        event: 'PAYMENT_INVALID_ORDER_STATUS',
        orderId,
        correlationId,
        status: 'error',
        message: 'Invalid order status for payment',
        data: { orderId, status: order.status }
      });

      return errorResponse('Order is not in a valid state for payment', 400);
    }

    // Simulate payment processing
    const paymentId = `payment-${Date.now()}`;
    const paymentStatus = Math.random() > 0.1 ? 'APPROVED' : 'FAILED'; // 90% success rate

    const payment = {
      id: paymentId,
      orderId,
      amount: parseFloat(amount),
      status: paymentStatus,
      createdAt: new Date().toISOString()
    };

    await putItem('payments', payment);

    // Update order status based on payment result
    const newStatus = paymentStatus === 'APPROVED' ? 'PAYMENT_APPROVED' : 'FAILED';
    await updateItem('orders', { id: orderId },
      'SET #status = :status, updatedAt = :now',
      {
        ':status': newStatus,
        ':now': new Date().toISOString(),
        '#status': 'status'
      }
    );

    log({
      event: 'PAYMENT_' + (paymentStatus === 'APPROVED' ? 'SUCCESS' : 'FAILED'),
      orderId,
      correlationId,
      status: paymentStatus === 'APPROVED' ? 'success' : 'error',
      message: `Payment ${paymentStatus.toLowerCase()} for order ${orderId}`,
      data: payment
    });

    return successResponse(payment);

  } catch (error) {
    log({
      event: 'PAYMENT_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'Failed to process payment',
      error
    });

    return errorResponse('Failed to process payment', 500, error);
  }
}