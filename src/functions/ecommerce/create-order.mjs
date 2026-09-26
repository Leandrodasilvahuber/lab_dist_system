import { getItem, putItem, updateItem } from '../../shared/database.mjs';
import { successResponse, errorResponse } from '../../shared/response.mjs';
import { log, createLogContext } from '../../shared/logger.mjs';

export async function handler(event) {
  try {
    const { correlationId, idempotencyKey } = event.headers || {};
    const { productId, quantity } = JSON.parse(event.body);

    if (!productId || !quantity) {
      log({
        event: 'CREATE_ORDER_VALIDATION_ERROR',
        correlationId,
        status: 'error',
        message: 'Missing required fields',
        data: { productId, quantity }
      });

      return errorResponse('Missing required fields: productId, quantity', 400);
    }

    log({
      event: 'CREATE_ORDER_START',
      correlationId,
      status: 'info',
      message: 'Starting order creation',
      data: { productId, quantity }
    });

    // Check if product exists and has enough stock
    const product = await getItem('products', { id: productId });
    if (!product) {
      log({
        event: 'CREATE_ORDER_PRODUCT_NOT_FOUND',
        correlationId,
        status: 'error',
        message: 'Product not found',
        data: { productId }
      });

      return errorResponse('Product not found', 404);
    }

    const orderId = `order-${Date.now()}`;
    const total = product.price * quantity;

    const order = {
      id: orderId,
      productId,
      quantity,
      total,
      status: 'STARTED',
      createdAt: new Date().toISOString()
    };

    await putItem('orders', order);

    log({
      event: 'CREATE_ORDER_SUCCESS',
      orderId,
      correlationId,
      status: 'success',
      message: 'Order created successfully',
      data: order
    });

    // Update product to mark order in progress
    await updateItem('products', { id: productId },
      'SET ordersInProgress = if_not_exists(ordersInProgress, :val) + :inc',
      { ':val': 0, ':inc': 1 }
    );

    return successResponse(order, 201);

  } catch (error) {
    log({
      event: 'CREATE_ORDER_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'Failed to create order',
      error
    });

    return errorResponse('Failed to create order', 500, error);
  }
}