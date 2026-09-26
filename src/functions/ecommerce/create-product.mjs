import { putItem, getItem, updateItem } from '../../shared/database.mjs';
import { successResponse, errorResponse } from '../../shared/response.mjs';
import { log, createLogContext } from '../../shared/logger.mjs';

export async function handler(event) {
  try {
    const { correlationId, idempotencyKey } = event.headers || {};
    const { id, name, price, stock } = JSON.parse(event.body);

    if (!id || !name || !price || stock === undefined) {
      log({
        event: 'CREATE_PRODUCT_VALIDATION_ERROR',
        correlationId,
        status: 'error',
        message: 'Missing required fields',
        data: { id, name, price, stock }
      });

      return errorResponse('Missing required fields: id, name, price, stock', 400);
    }

    log({
      event: 'CREATE_PRODUCT_START',
      correlationId,
      status: 'info',
      message: 'Starting product creation',
      data: { id, name, price, stock }
    });

    // Check if product already exists
    const existingProduct = await getItem('products', { id });
    if (existingProduct) {
      log({
        event: 'CREATE_PRODUCT_EXISTS',
        correlationId,
        status: 'warning',
        message: 'Product already exists',
        data: { id }
      });

      return successResponse({
        id,
        name,
        price,
        stock,
        status: 'UPDATED'
      });
    }

    const product = {
      id,
      name,
      price: parseFloat(price),
      stock: parseInt(stock),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await putItem('products', product);

    log({
      event: 'CREATE_PRODUCT_SUCCESS',
      correlationId,
      status: 'success',
      message: 'Product created successfully',
      data: product
    });

    return successResponse(product, 201);

  } catch (error) {
    log({
      event: 'CREATE_PRODUCT_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'Failed to create product',
      error
    });

    return errorResponse('Failed to create product', 500, error);
  }
}