import { getItem, updateItem, queryItems } from '../../shared/database.mjs';
import { successResponse, errorResponse } from '../../shared/response.mjs';
import { log, createLogContext } from '../../shared/logger.mjs';

export async function handler(event) {
  try {
    const { correlationId, idempotencyKey } = event.headers || {};
    const { orderId } = event.pathParameters || {};

    if (!orderId) {
      log({
        event: 'CANCEL_ORDER_VALIDATION_ERROR',
        correlationId,
        status: 'error',
        message: 'Missing orderId',
        data: { orderId }
      });

      return errorResponse('Missing orderId', 400);
    }

    log({
      event: 'CANCEL_ORDER_START',
      orderId,
      correlationId,
      status: 'info',
      message: 'Starting order cancellation'
    });

    // Get order
    const order = await getItem('orders', { id: orderId });
    if (!order) {
      log({
        event: 'CANCEL_ORDER_NOT_FOUND',
        orderId,
        correlationId,
        status: 'error',
        message: 'Order not found',
        data: { orderId }
      });

      return errorResponse('Order not found', 404);
    }

    // Check if order can be cancelled
    const finalStatuses = ['COMPLETED', 'CANCELLED', 'FAILED'];
    if (finalStatuses.includes(order.status)) {
      log({
        event: 'CANCEL_ORDER_INVALID_STATUS',
        orderId,
        correlationId,
        status: 'error',
        message: 'Cannot cancel completed, cancelled, or failed orders',
        data: { orderId, status: order.status }
      });

      return errorResponse('Order cannot be cancelled in current state', 400);
    }

    // Get payment for this order
    const payments = await queryItems('payments', {
      IndexName: 'order-id-index',
      KeyConditionExpression: 'orderId = :orderId',
      ExpressionAttributeValues: { ':orderId': orderId }
    });

    const payment = payments.find(p => p.orderId === orderId);

    // If payment exists and was approved, refund it
    if (payment && payment.status === 'APPROVED') {
      await updateItem('payments', { id: payment.id },
        'SET #status = :status, updatedAt = :now',
        {
          ':status': 'REFUNDED',
          ':now': new Date().toISOString(),
          '#status': 'status'
        }
      );
    }

    // Cancel order
    await updateItem('orders', { id: orderId },
      'SET #status = :status, updatedAt = :now',
      {
        ':status': 'CANCELLED',
        ':now': new Date().toISOString(),
        '#status': 'status'
      }
    );

    // If order had stock reserved, release it
    if (order.status === 'STOCK_RESERVED' || order.status === 'PAYMENT_APPROVED') {
      const product = await getItem('products', { id: order.productId });
      if (product) {
        await updateItem('products', { id: order.productId },
          'SET stock = :newStock, reserved = :newReserved, updatedAt = :now',
          {
            ':newStock': (product.stock || 0) + order.quantity,
            ':newReserved': Math.max(0, (product.reserved || 0) - order.quantity),
            ':now': new Date().toISOString()
          }
        );
      }
    }

    log({
      event: 'CANCEL_ORDER_SUCCESS',
      orderId,
      correlationId,
      status: 'success',
      message: 'Order cancelled successfully'
    });

    return successResponse({
      orderId,
      status: 'CANCELLED',
      cancelledAt: new Date().toISOString(),
      paymentRefunded: payment && payment.status === 'REFUNDED'
    });

  } catch (error) {
    log({
      event: 'CANCEL_ORDER_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'Failed to cancel order',
      error
    });

    return errorResponse('Failed to cancel order', 500, error);
  }
}