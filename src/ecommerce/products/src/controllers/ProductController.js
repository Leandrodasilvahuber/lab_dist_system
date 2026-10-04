import { ProductSDK } from '../../../../common/sdks/index.mjs';
import { eventBus } from '../../../../common/event-bus.mjs';
import { successResponse, errorResponse, parseBody, sdkErrorResponse } from '../../../../common/response.mjs';
import { toNumber, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH } from '../../../../common/validation.mjs';
import { parsePagination } from '../../../../common/pagination.mjs';

const productSDK = new ProductSDK(eventBus);

export class ProductController {
  /**
   * GET /products (paginado: ?limit=&nextToken=)
   */
  static async listProducts(event, query = {}) {
    try {
      const page = await productSDK.listProducts(query, parsePagination(query));
      return successResponse(page);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to get products', event.headers?.correlationId);
    }
  }

  /**
   * GET /products/{id}. O id vem só do path: ?id= na listagem não vira busca.
   */
  static async getProduct(event, productId) {
    try {
      return successResponse(await productSDK.getProduct(productId));
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to get product', event.headers?.correlationId);
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
      if (name.trim().length > MAX_NAME_LENGTH) {
        return errorResponse(`name must have at most ${MAX_NAME_LENGTH} characters`, 400);
      }
      const priceValue = toNumber(price);
      // Preço zero não é comprável: o pagamento exige valor maior que zero
      if (!Number.isFinite(priceValue) || priceValue <= 0) {
        return errorResponse('price must be a positive number', 400);
      }
      if (typeof description !== 'string') {
        return errorResponse('description must be a string', 400);
      }
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        return errorResponse(`description must have at most ${MAX_DESCRIPTION_LENGTH} characters`, 400);
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
      return sdkErrorResponse(error, 'Failed to create product', event.headers?.correlationId);
    }
  }
}
