import { ProductSDK } from '../../../../common/sdks/index.mjs';
import { eventBus } from '../../../../common/event-bus.mjs';
import { successResponse, errorResponse, parseBody, sdkErrorResponse } from '../../../../common/response.mjs';

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

      if (!name || price === undefined) {
        return errorResponse('Missing required fields: name, price', 400);
      }
      if (Number.isNaN(Number(price)) || Number(price) < 0) {
        return errorResponse('Price must be a non-negative number', 400);
      }

      const product = await productSDK.createProduct({
        name,
        price: Number(price),
        description,
        stock: parseInt(stock, 10) || 0,
        ordersInProgress: 0
      });

      return successResponse(product, 201);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to create product');
    }
  }
}
