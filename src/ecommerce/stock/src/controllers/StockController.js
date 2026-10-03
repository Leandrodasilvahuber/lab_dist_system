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
   * POST /stock/{productId}/reserve
   */
  static async reserveStock(event) {
    try {
      const { productId } = event.pathParameters || {};
      const { quantity, correlationId } = parseBody(event);

      if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
        return errorResponse('Quantity must be a positive integer', 400);
      }

      const reservation = await stockSDK.reserveStock({
        productId,
        quantity: Number(quantity),
        correlationId
      });

      return successResponse(reservation, 201);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to reserve stock');
    }
  }

  /**
   * POST /stock/{productId}/release  body: { reservationId }
   */
  static async releaseStock(event) {
    try {
      const { productId } = event.pathParameters || {};
      const { reservationId, correlationId } = parseBody(event);

      if (!reservationId) {
        return errorResponse('Missing required field: reservationId', 400);
      }

      const reservation = await stockSDK.getReservation(reservationId);
      if (reservation.productId !== productId) {
        return errorResponse('Reservation not found for this product', 404);
      }

      const released = await stockSDK.releaseStock({ reservationId, correlationId });
      return successResponse(released);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to release stock');
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
