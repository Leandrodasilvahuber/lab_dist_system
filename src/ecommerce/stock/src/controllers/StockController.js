import { StockSDK } from '../../../../common/sdks/index.mjs';
import { eventBus } from '../../../../common/event-bus.mjs';
import { successResponse, errorResponse, parseBody, sdkErrorResponse } from '../../../../common/response.mjs';

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

      if (!Number.isInteger(Number(delta)) || Number(delta) === 0) {
        return errorResponse('delta must be a non-zero integer', 400);
      }

      const result = await stockSDK.adjustStock(productId, Number(delta), { name });
      return successResponse(result);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to adjust stock');
    }
  }
}
