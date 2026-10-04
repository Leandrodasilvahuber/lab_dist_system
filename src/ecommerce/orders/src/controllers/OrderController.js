import { OrderSDK } from '../../../../common/sdks/index.mjs';
import { eventBus } from '../../../../common/event-bus.mjs';
import { successResponse, sdkErrorResponse } from '../../../../common/response.mjs';
import { parsePagination } from '../../../../common/pagination.mjs';

const orderSDK = new OrderSDK(eventBus);

export class OrderController {
  /**
   * GET /orders (admin, paginado: ?limit=&nextToken=) e GET /orders/{id}
   */
  static async getOrders(event, params = {}) {
    try {
      if (params.id) {
        const order = await orderSDK.getOrder(params.id);
        return successResponse(order);
      }

      const page = await orderSDK.listOrders(params, parsePagination(params));
      return successResponse(page);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to get orders');
    }
  }
}
