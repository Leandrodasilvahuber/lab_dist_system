import { getItem, updateItem, getItem as getProduct } from '../../shared/database.mjs';
import { successResponse, errorResponse } from '../../shared/response.mjs';
import { log, createLogContext } from '../../shared/logger.mjs';

export async function handler(event) {
  try {
    const { correlationId, idempotencyKey } = event.headers || {};
    const { orderId, productId, quantity } = JSON.parse(event.body);

    if (!orderId || !productId || !quantity) {
      log({
        event: 'RESERVE_STOCK_VALIDATION_ERROR',
        correlationId,
        status: 'error',
        message: 'Missing required fields',
        data: { orderId, productId, quantity }
      });

      return errorResponse('Missing required fields: orderId, productId, quantity', 400);
    }

    log({
      event: 'RESERVE_STOCK_START',
      orderId,
      correlationId,
      status: 'info',
      message: 'Starting stock reservation',
      data: { orderId, productId, quantity }
    });

    // Check if order exists and is in correct state
    const order = await getItem('orders', { id: orderId });
    if (!order) {
      log({
        event: 'RESERVE_STOCK_ORDER_NOT_FOUND',
        orderId,
        correlationId,
        status: 'error',
        message: 'Order not found',
        data: { orderId }
      });

      return errorResponse('Order not found', 404);
    }

    if (order.status !== 'PAYMENT_APPROVED') {
      log({
        event: 'RESERVE_STOCK_INVALID_ORDER_STATUS',
        orderId,
        correlationId,
        status: 'error',
        message: 'Order not in payment approved state',
        data: { orderId, status: order.status }
      });

      return errorResponse('Order must have payment approved before stock reservation', 400);
    }

    // Get product details
    const product = await getProduct('products', { id: productId });
    if (!product) {
      log({
        event: 'RESERVE_STOCK_PRODUCT_NOT_FOUND',
        orderId,
        correlationId,
        status: 'error',
        message: 'Product not found',
        data: { productId }
      });

      return errorResponse('Product not found', 404);
    }

    // Check available stock
    const availableStock = product.stock || 0;
    const reservedStock = product.reserved || 0;
    const totalAvailable = availableStock - reservedStock;

    if (totalAvailable < quantity) {
      log({
        event: 'RESERVE_STOCK_INSUFFICIENT',
        orderId,
        correlationId,
        status: 'error',
        message: 'Insufficient stock available',
        data: {
          productId,
          available: totalAvailable,
          required: quantity,
          availableStock,
          reservedStock
        }
      });

      return errorResponse('Insufficient stock available', 400);
    }

    // Reserve stock
    await updateItem('products', { id: productId },
      'SET stock = :newStock, reserved = :newReserved, updatedAt = :now',
      {
        ':newStock': availableStock - quantity,
        ':newReserved': reservedStock + quantity,
        ':now': new Date().toISOString()
      }
    );

    // Update order status
    await updateItem('orders', { id: orderId },
      'SET #status = :status, updatedAt = :now',
      {
        ':status': 'STOCK_RESERVED',
        ':now': new Date().toISOString(),
        '#status': 'status'
      }
    );

    log({
      event: 'RESERVE_STOCK_SUCCESS',
      orderId,
      correlationId,
      status: 'success',
      message: 'Stock reserved successfully',
      data: {
        productId,
        quantity,
        remainingStock: availableStock - quantity,
        reservedStock: reservedStock + quantity
      }
    });

    const result = {
      productId,
      quantity,
      available: availableStock - quantity,
      reserved: reservedStock + quantity
    };

    return successResponse(result);

  } catch (error) {
    log({
      event: 'RESERVE_STOCK_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'Failed to reserve stock',
      error
    });

    return errorResponse('Failed to reserve stock', 500, error);
  }
}