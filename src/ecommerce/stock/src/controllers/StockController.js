import { StockSDK } from '../../../../common/sdks/index.mjs';
import { eventBus } from '../../../../common/event-bus.mjs';
import { successResponse, errorResponse, parseBody, sdkErrorResponse } from '../../../../common/response.mjs';
import { toNumber, MAX_NAME_LENGTH } from '../../../../common/validation.mjs';
import { parsePagination } from '../../../../common/pagination.mjs';

const stockSDK = new StockSDK(eventBus);

export class StockController {
  /**
   * GET /stock (paginado: ?limit=&nextToken=) e GET /stock/{productId}
   */
  static async getStock(event, params = {}) {
    try {
      if (event.pathParameters?.productId) {
        const stock = await stockSDK.getStock(event.pathParameters.productId);
        return successResponse(stock);
      }

      const page = await stockSDK.listStock(params, parsePagination(params));
      return successResponse(page);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to get stock', event.headers?.correlationId);
    }
  }

  /**
   * POST /stock/{productId}/adjust
   */
  static async adjustStock(event) {
    try {
      const { productId } = event.pathParameters || {};
      const { delta, name } = parseBody(event);

      const deltaValue = toNumber(delta);
      if (!Number.isInteger(deltaValue) || deltaValue === 0) {
        return errorResponse('delta must be a non-zero integer', 400);
      }
      if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
        return errorResponse('name must be a non-empty string', 400);
      }
      if (name !== undefined && name.trim().length > MAX_NAME_LENGTH) {
        return errorResponse(`name must have at most ${MAX_NAME_LENGTH} characters`, 400);
      }

      const result = await stockSDK.adjustStock(productId, deltaValue, { name: name?.trim() });
      return successResponse(result);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to adjust stock', event.headers?.correlationId);
    }
  }
}
