import { ProductSDK } from '../../../../common/sdks/index.mjs';
import { eventBus } from '../../../../common/event-bus.mjs';
import { successResponse, errorResponse, parseBody, sdkErrorResponse } from '../../../../common/response.mjs';
import { toNumber } from '../../../../common/validation.mjs';

const productSDK = new ProductSDK(eventBus);

export class ProductController {
  /**
   * GET /products e GET /products/{id}
   */
  static async getProducts(event, params = {}) {
    try {
      if (params.id) {
        const product = await productSDK.getProduct(params.id);
        return successResponse(product);
      }

      const products = await productSDK.listProducts(params);
      return successResponse({ products });
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to get products');
    }
  }

  /**
   * POST /products
   */
  static async createProduct(event) {
    try {
      const { name, price, description = '', stock = 0 } = parseBody(event);

      if (typeof name !== 'string' || !name.trim()) {
        return errorResponse('name is required', 400);
      }
      const priceValue = toNumber(price);
      if (!Number.isFinite(priceValue) || priceValue < 0) {
        return errorResponse('price must be a non-negative number', 400);
      }
      if (typeof description !== 'string') {
        return errorResponse('description must be a string', 400);
      }
      const initialStock = toNumber(stock);
      if (!Number.isInteger(initialStock) || initialStock < 0) {
        return errorResponse('stock must be a non-negative integer', 400);
      }

      const product = await productSDK.createProduct({
        name: name.trim(),
        price: priceValue,
        description,
        initialStock
      });

      return successResponse(product, 201);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to create product');
    }
  }
}
