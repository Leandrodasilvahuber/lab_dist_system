import { getItem, scanItems } from '../../shared/database.mjs';
import { successResponse, errorResponse } from '../../shared/response.mjs';
import { log, createLogContext } from '../../shared/logger.mjs';

export async function handler(event, { id } = {}) {
  try {
    const { correlationId, idempotencyKey } = event.headers || {};

    if (id) {
      log({
        event: 'GET_ORDER_BY_ID',
        correlationId,
        status: 'info',
        message: 'Getting order by ID',
        data: { id }
      });

      const order = await getItem('orders', { id });

      if (!order) {
        log({
          event: 'GET_ORDER_NOT_FOUND',
          correlationId,
          status: 'error',
          message: 'Order not found',
          data: { id }
        });

        return errorResponse('Order not found', 404);
      }

      log({
        event: 'GET_ORDER_SUCCESS',
        correlationId,
        status: 'success',
        message: 'Order found successfully'
      });

      return successResponse(order);
    }

    log({
      event: 'GET_ALL_ORDERS_START',
      correlationId,
      status: 'info',
      message: 'Getting all orders'
    });

    const orders = await scanItems('orders');

    log({
      event: 'GET_ALL_ORDERS_SUCCESS',
      correlationId,
      status: 'success',
      message: `Found ${orders.length} orders`
    });

    return successResponse(orders);

  } catch (error) {
    log({
      event: 'GET_ORDERS_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'Failed to get orders',
      error
    });

    return errorResponse('Failed to get orders', 500, error);
  }
}