import { OrderSDK } from '../../../../common/sdks/index.mjs';
import { eventBus } from '../../../../common/event-bus.mjs';
import { successResponse, sdkErrorResponse } from '../../../../common/response.mjs';
import { parsePagination } from '../../../../common/pagination.mjs';

const orderSDK = new OrderSDK(eventBus);

export class OrderController {
  /**
   * GET /orders (admin, paginado: ?limit=&nextToken=)
   */
  static async listOrders(event, query = {}) {
    try {
      const page = await orderSDK.listOrders(query, parsePagination(query));
      return successResponse(page);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to get orders');
    }
  }

  /**
   * GET /orders/{id}. O id vem só do path: ?id= na listagem não vira busca.
   */
  static async getOrder(event, orderId) {
    try {
      return successResponse(await orderSDK.getOrder(orderId));
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to get order');
    }
  }
}
