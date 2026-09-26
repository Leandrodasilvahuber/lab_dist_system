import { Order } from '../models/Order.js';
import { Database } from '../../../../common/database.mjs';
import { successResponse, errorResponse } from '../../../../common/response.mjs';

const db = new Database();

export class OrderController {
  static async getOrders(event, queryStringParameters) {
    try {
      const { correlationId, idempotencyKey } = event.headers || {};

      if (queryStringParameters?.id) {
        const order = await db.getItem('orders', { id: queryStringParameters.id });

        if (!order) {
          return errorResponse('Order not found', 404);
        }

        const orderInstance = Order.fromDynamo(order);

        return successResponse(orderInstance);
      }

      const orders = await db.scanItems('orders');
      const orderInstances = orders.map(o => Order.fromDynamo(o));

      return successResponse(orderInstances);

    } catch (error) {
      return errorResponse('Failed to get orders', 500, error);
    }
  }

  static async createOrder(event) {
    try {
      const { correlationId, idempotencyKey } = event.headers || {};
      const { productId, quantity } = JSON.parse(event.body);

      if (!productId || !quantity) {
        return errorResponse('Missing required fields: productId, quantity', 400);
      }

      const product = await db.getItem('products', { id: productId });
      if (!product) {
        return errorResponse('Product not found', 404);
      }

      const orderId = `order-${Date.now()}`;
      const total = product.price * quantity;

      const order = new Order({
        id: orderId,
        productId,
        quantity: parseInt(quantity),
        total,
        status: 'STARTED',
        createdAt: new Date().toISOString()
      });

      await db.putItem('orders', order.toDynamo());

      return successResponse(order, 201);

    } catch (error) {
      return errorResponse('Failed to create order', 500, error);
    }
  }

  static async confirmOrder(event) {
    try {
      const { correlationId, idempotencyKey } = event.headers || {};
      const { orderId } = JSON.parse(event.body);

      if (!orderId) {
        return errorResponse('Missing required field: orderId', 400);
      }

      const order = await db.getItem('orders', { id: orderId });
      if (!order) {
        return errorResponse('Order not found', 404);
      }

      const orderInstance = Order.fromDynamo(order);
      if (!orderInstance.canConfirm()) {
        return errorResponse('Order cannot be confirmed in current state', 400);
      }

      orderInstance.status = 'COMPLETED';
      orderInstance.updatedAt = new Date().toISOString();

      await db.updateItem('orders', { id: orderId },
        'SET #status = :status, updatedAt = :now',
        {
          ':status': 'COMPLETED',
          ':now': new Date().toISOString(),
          '#status': 'status'
        }
      );

      return successResponse(orderInstance);

    } catch (error) {
      return errorResponse('Failed to confirm order', 500, error);
    }
  }

  static async cancelOrder(event) {
    try {
      const { correlationId, idempotencyKey } = event.headers || {};
      const { orderId } = JSON.parse(event.body);

      if (!orderId) {
        return errorResponse('Missing required field: orderId', 400);
      }

      const order = await db.getItem('orders', { id: orderId });
      if (!order) {
        return errorResponse('Order not found', 404);
      }

      const orderInstance = Order.fromDynamo(order);
      if (!orderInstance.canCancel()) {
        return errorResponse('Order cannot be cancelled in current state', 400);
      }

      orderInstance.status = 'CANCELLED';
      orderInstance.updatedAt = new Date().toISOString();

      await db.updateItem('orders', { id: orderId },
        'SET #status = :status, updatedAt = :now',
        {
          ':status': 'CANCELLED',
          ':now': new Date().toISOString(),
          '#status': 'status'
        }
      );

      return successResponse(orderInstance);

    } catch (error) {
      return errorResponse('Failed to cancel order', 500, error);
    }
  }

  // Compensating action for saga orchestration
  static async cancelOrderForSaga(orderId) {
    try {
      const order = await db.getItem('orders', { id: orderId });
      if (!order) {
        return { success: false, error: 'Order not found' };
      }

      const orderInstance = Order.fromDynamo(order);

      if (!orderInstance.canCancel()) {
        return { success: false, error: 'Order cannot be cancelled in current state' };
      }

      orderInstance.status = 'CANCELLED';
      orderInstance.updatedAt = new Date().toISOString();

      await db.updateItem('orders', { id: orderId },
        'SET #status = :status, updatedAt = :now',
        {
          ':status': 'CANCELLED',
          ':now': new Date().toISOString(),
          '#status': 'status'
        }
      );

      return { success: true, order: orderInstance };

    } catch (error) {
      return { success: false, error: error.message || error };
    }
  }
}