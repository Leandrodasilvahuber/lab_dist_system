import { getItem, updateItem } from '../../shared/database.mjs';
import { successResponse, errorResponse } from '../../shared/response.mjs';
import { log, createLogContext } from '../../shared/logger.mjs';

export async function handler(event) {
  try {
    const { correlationId, idempotencyKey } = event.headers || {};
    const { orderId } = event.pathParameters || {};

    if (!orderId) {
      log({
        event: 'CONFIRM_ORDER_VALIDATION_ERROR',
        correlationId,
        status: 'error',
        message: 'Missing orderId',
        data: { orderId }
      });

      return errorResponse('Missing orderId', 400);
    }

    log({
      event: 'CONFIRM_ORDER_START',
      orderId,
      correlationId,
      status: 'info',
      message: 'Starting order confirmation'
    });

    // Get order
    const order = await getItem('orders', { id: orderId });
    if (!order) {
      log({
        event: 'CONFIRM_ORDER_NOT_FOUND',
        orderId,
        correlationId,
        status: 'error',
        message: 'Order not found',
        data: { orderId }
      });

      return errorResponse('Order not found', 404);
    }

    // Check if order is ready for confirmation
    if (order.status !== 'STOCK_RESERVED') {
      log({
        event: 'CONFIRM_ORDER_INVALID_STATUS',
        orderId,
        correlationId,
        status: 'error',
        message: 'Order not ready for confirmation',
        data: { orderId, status: order.status }
      });

      return errorResponse('Order must have stock reserved before confirmation', 400);
    }

    // Confirm order
    await updateItem('orders', { id: orderId },
      'SET #status = :status, updatedAt = :now',
      {
        ':status': 'COMPLETED',
        ':now': new Date().toISOString(),
        '#status': 'status'
      }
    );

    log({
      event: 'CONFIRM_ORDER_SUCCESS',
      orderId,
      correlationId,
      status: 'success',
      message: 'Order confirmed successfully'
    });

    return successResponse({
      orderId,
      status: 'COMPLETED',
      confirmedAt: new Date().toISOString()
    });

  } catch (error) {
    log({
      event: 'CONFIRM_ORDER_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'Failed to confirm order',
      error
    });

    return errorResponse('Failed to confirm order', 500, error);
  }
}