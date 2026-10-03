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
   * POST /orders
   */
  static async createOrder(event) {
    try {
      const { productId, quantity, correlationId } = parseBody(event);

      if (!productId || quantity === undefined) {
        return errorResponse('Missing required fields: productId, quantity', 400);
      }
      if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
        return errorResponse('Quantity must be a positive integer', 400);
      }

      const order = await orderSDK.createOrder({
        productId,
        quantity: Number(quantity),
        correlationId: correlationId || event.headers?.['x-correlation-id']
      });

      return successResponse(order, 201);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to create order');
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
