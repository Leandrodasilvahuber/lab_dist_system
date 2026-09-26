import { getItem, updateItem, getItem as getProduct } from '../../shared/database.mjs';
import { successResponse, errorResponse } from '../../shared/response.mjs';
import { log, createLogContext } from '../../shared/logger.mjs';

export async function handler(event) {
  try {
    const { correlationId, idempotencyKey } = event.headers || {};
    const { orderId, productId, quantity } = JSON.parse(event.body);

    if (!orderId || !productId || !quantity) {
      log({
        event: 'RELEASE_STOCK_VALIDATION_ERROR',
        correlationId,
        status: 'error',
        message: 'Missing required fields',
        data: { orderId, productId, quantity }
      });

      return errorResponse('Missing required fields: orderId, productId, quantity', 400);
    }

    log({
      event: 'RELEASE_STOCK_START',
      orderId,
      correlationId,
      status: 'info',
      message: 'Starting stock release',
      data: { orderId, productId, quantity }
    });

    // Check if order exists
    const order = await getItem('orders', { id: orderId });
    if (!order) {
      log({
        event: 'RELEASE_STOCK_ORDER_NOT_FOUND',
        orderId,
        correlationId,
        status: 'error',
        message: 'Order not found',
        data: { orderId }
      });

      return errorResponse('Order not found', 404);
    }

    // Get product details
    const product = await getProduct('products', { id: productId });
    if (!product) {
      log({
        event: 'RELEASE_STOCK_PRODUCT_NOT_FOUND',
        orderId,
        correlationId,
        status: 'error',
        message: 'Product not found',
        data: { productId }
      });

      return errorResponse('Product not found', 404);
    }

    // Release stock
    await updateItem('products', { id: productId },
      'SET stock = :newStock, reserved = :newReserved, updatedAt = :now',
      {
        ':newStock': (product.stock || 0) + quantity,
        ':newReserved': Math.max(0, (product.reserved || 0) - quantity),
        ':now': new Date().toISOString()
      }
    );

    // Update order status if needed
    await updateItem('orders', { id: orderId },
      'SET #status = :status, updatedAt = :now',
      {
        ':status': 'CANCELLED',
        ':now': new Date().toISOString(),
        '#status': 'status'
      }
    );

    log({
      event: 'RELEASE_STOCK_SUCCESS',
      orderId,
      correlationId,
      status: 'success',
      message: 'Stock released successfully',
      data: {
        productId,
        quantity,
        newStock: (product.stock || 0) + quantity,
        newReserved: Math.max(0, (product.reserved || 0) - quantity)
      }
    });

    const result = {
      productId,
      quantity,
      available: (product.stock || 0) + quantity,
      reserved: Math.max(0, (product.reserved || 0) - quantity)
    };

    return successResponse(result);

  } catch (error) {
    log({
      event: 'RELEASE_STOCK_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'Failed to release stock',
      error
    });

    return errorResponse('Failed to release stock', 500, error);
  }
}