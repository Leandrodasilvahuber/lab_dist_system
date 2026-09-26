import { getItem, scanItems } from '../../shared/database.mjs';
import { successResponse, errorResponse } from '../../shared/response.mjs';
import { log, createLogContext } from '../../shared/logger.mjs';

export async function handler(event, { id } = {}) {
  try {
    const { correlationId, idempotencyKey } = event.headers || {};

    if (id) {
      log({
        event: 'GET_PRODUCT_BY_ID',
        correlationId,
        status: 'info',
        message: 'Getting product by ID',
        data: { id }
      });

      const product = await getItem('products', { id });

      if (!product) {
        log({
          event: 'GET_PRODUCT_NOT_FOUND',
          correlationId,
          status: 'error',
          message: 'Product not found',
          data: { id }
        });

        return errorResponse('Product not found', 404);
      }

      log({
        event: 'GET_PRODUCT_SUCCESS',
        correlationId,
        status: 'success',
        message: 'Product found successfully'
      });

      return successResponse(product);
    }

    log({
      event: 'GET_ALL_PRODUCTS_START',
      correlationId,
      status: 'info',
      message: 'Getting all products'
    });

    const products = await scanItems('products');

    log({
      event: 'GET_ALL_PRODUCTS_SUCCESS',
      correlationId,
      status: 'success',
      message: `Found ${products.length} products`
    });

    return successResponse(products);

  } catch (error) {
    log({
      event: 'GET_PRODUCTS_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'Failed to get products',
      error
    });

    return errorResponse('Failed to get products', 500, error);
  }
}