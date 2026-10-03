import { OrderSDK } from '../../../../common/sdks/index.mjs';
import { eventBus } from '../../../../common/event-bus.mjs';
import { successResponse, sdkErrorResponse } from '../../../../common/response.mjs';

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
}
