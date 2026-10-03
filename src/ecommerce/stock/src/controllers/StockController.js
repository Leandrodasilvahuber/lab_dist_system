import { StockSDK } from '../../../../common/sdks/index.mjs';
import { eventBus } from '../../../../common/event-bus.mjs';
import { successResponse, errorResponse, parseBody, sdkErrorResponse } from '../../../../common/response.mjs';
import { toNumber } from '../../../../common/validation.mjs';

const stockSDK = new StockSDK(eventBus);

export class StockController {
  /**
   * GET /stock e GET /stock/{productId}
   */
  static async getStock(event, params = {}) {
    try {
      if (event.pathParameters?.productId) {
        const stock = await stockSDK.getStock(event.pathParameters.productId);
        return successResponse(stock);
      }

      const stock = await stockSDK.listStock(params);
      return successResponse({ stock });
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to get stock');
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

      const result = await stockSDK.adjustStock(productId, deltaValue, { name: name?.trim() });
      return successResponse(result);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to adjust stock');
    }
  }
}
