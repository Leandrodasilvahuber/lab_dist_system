import { ProductSDK } from '../../../../common/sdks/index.mjs';
import { eventBus } from '../../../../common/event-bus.mjs';
import { successResponse, errorResponse, parseBody, sdkErrorResponse } from '../../../../common/response.mjs';
import { toNumber } from '../../../../common/validation.mjs';
import { parsePagination } from '../../../../common/pagination.mjs';

const productSDK = new ProductSDK(eventBus);

export class ProductController {
  /**
   * GET /products (paginado: ?limit=&nextToken=) e GET /products/{id}
   */
  static async getProducts(event, params = {}) {
    try {
      if (params.id) {
        const product = await productSDK.getProduct(params.id);
        return successResponse(product);
      }

      const page = await productSDK.listProducts(params, parsePagination(params));
      return successResponse(page);
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
      // Preço zero não é comprável: o pagamento exige valor maior que zero
      if (!Number.isFinite(priceValue) || priceValue <= 0) {
        return errorResponse('price must be a positive number', 400);
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
