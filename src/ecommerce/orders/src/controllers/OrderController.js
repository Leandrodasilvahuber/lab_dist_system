import { OrderSDK } from '../../../../common/sdks/index.mjs';
import { eventBus } from '../../../../common/event-bus.mjs';
import { successResponse, errorResponse, parseBody, sdkErrorResponse } from '../../../../common/response.mjs';

const orderSDK = new OrderSDK(eventBus);

export class OrderController {
  /**
   * GET /orders e GET /orders/{id}
   */
  static async getOrders(event, params = {}) {
    try {
      if (params.id) {
        const order = await orderSDK.getOrder(params.id);
        return successResponse(order);
      }

      const orders = await orderSDK.listOrders(params);
      return successResponse({ orders });
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to get orders');
    }
  }

  /**
   * POST /orders/confirm
   */
  static async confirmOrder(event) {
    try {
      const { orderId, correlationId } = parseBody(event);

      if (!orderId) {
        return errorResponse('Missing required field: orderId', 400);
      }

      const order = await orderSDK.confirmOrder(orderId, correlationId);
      return successResponse(order);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to confirm order');
    }
  }

  /**
   * POST /orders/cancel
   */
  static async cancelOrder(event) {
    try {
      const { orderId, correlationId } = parseBody(event);

      if (!orderId) {
        return errorResponse('Missing required field: orderId', 400);
      }

      const order = await orderSDK.cancelOrder(orderId, correlationId);
      return successResponse(order);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to cancel order');
    }
  }
}
