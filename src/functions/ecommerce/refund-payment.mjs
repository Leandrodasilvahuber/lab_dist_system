import { getItem, updateItem, queryItems } from '../../shared/database.mjs';
import { successResponse, errorResponse } from '../../shared/response.mjs';
import { log, createLogContext } from '../../shared/logger.mjs';

export async function handler(event) {
  try {
    const { correlationId, idempotencyKey } = event.headers || {};
    const { orderId } = event.pathParameters || {};

    if (!orderId) {
      log({
        event: 'REFUND_PAYMENT_VALIDATION_ERROR',
        correlationId,
        status: 'error',
        message: 'Missing orderId',
        data: { orderId }
      });

      return errorResponse('Missing orderId', 400);
    }

    log({
      event: 'REFUND_PAYMENT_START',
      orderId,
      correlationId,
      status: 'info',
      message: 'Starting payment refund'
    });

    // Get order
    const order = await getItem('orders', { id: orderId });
    if (!order) {
      log({
        event: 'REFUND_ORDER_NOT_FOUND',
        orderId,
        correlationId,
        status: 'error',
        message: 'Order not found',
        data: { orderId }
      });

      return errorResponse('Order not found', 404);
    }

    // Get payment for this order
    const payments = await queryItems('payments', {
      IndexName: 'order-id-index',
      KeyConditionExpression: 'orderId = :orderId',
      ExpressionAttributeValues: { ':orderId': orderId }
    });

    const payment = payments.find(p => p.orderId === orderId);
    if (!payment) {
      log({
        event: 'REFUND_PAYMENT_NOT_FOUND',
        orderId,
        correlationId,
        status: 'error',
        message: 'Payment not found for order',
        data: { orderId }
      });

      return errorResponse('Payment not found for order', 404);
    }

    if (payment.status === 'REFUNDED') {
      log({
        event: 'REFUND_ALREADY_REFUNDED',
        orderId,
        correlationId,
        status: 'warning',
        message: 'Payment already refunded',
        data: { orderId, paymentId: payment.id }
      });

      return successResponse({
        paymentId: payment.id,
        status: 'REFUNDED'
      });
    }

    // Simulate refund process
    await updateItem('payments', { id: payment.id },
      'SET #status = :status, updatedAt = :now',
      {
        ':status': 'REFUNDED',
        ':now': new Date().toISOString(),
        '#status': 'status'
      }
    );

    log({
      event: 'REFUND_PAYMENT_SUCCESS',
      orderId,
      correlationId,
      status: 'success',
      message: 'Payment refunded successfully',
      data: { paymentId: payment.id }
    });

    return successResponse({
      paymentId: payment.id,
      status: 'REFUNDED'
    });

  } catch (error) {
    log({
      event: 'REFUND_PAYMENT_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'Failed to refund payment',
      error
    });

    return errorResponse('Failed to refund payment', 500, error);
  }
}