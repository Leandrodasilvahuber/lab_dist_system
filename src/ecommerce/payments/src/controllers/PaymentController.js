import { Order } from '../../../ecommerce/orders/src/models/Order.js';
import { Payment } from '../models/Payment.js';
import { Database } from '../../../../common/database.mjs';
import { successResponse, errorResponse } from '../../../../common/response.mjs';

const db = new Database();

export class PaymentController {
  static async processPayment(event) {
    try {
      const { correlationId, idempotencyKey } = event.headers || {};
      const { orderId, amount, method = 'CREDIT_CARD' } = JSON.parse(event.body);

      if (!orderId || !amount) {
        return errorResponse('Missing required fields: orderId, amount', 400);
      }

      const order = await db.getItem('orders', { id: orderId });
      if (!order) {
        return errorResponse('Order not found', 404);
      }

      const orderInstance = Order.fromDynamo(order);
      if (!orderInstance.canProcessPayment()) {
        return errorResponse('Order cannot be processed for payment', 400);
      }

      const paymentId = `payment-${Date.now()}`;
      const paymentStatus = Math.random() > 0.1 ? 'APPROVED' : 'FAILED';

      const payment = new Payment({
        id: paymentId,
        orderId,
        amount: parseFloat(amount),
        status: paymentStatus,
        method
      });

      await db.putItem('payments', payment.toDynamo());

      // Update order status based on payment result
      const newStatus = paymentStatus === 'APPROVED' ? 'PAYMENT_APPROVED' : 'FAILED';
      await db.updateItem('orders', { id: orderId },
        'SET #status = :status, updatedAt = :now',
        {
          ':status': newStatus,
          ':now': new Date().toISOString(),
          '#status': 'status'
        }
      );

      return successResponse(payment);

    } catch (error) {
      return errorResponse('Failed to process payment', 500, error);
    }
  }

  static async refundPayment(event) {
    try {
      const { correlationId, idempotencyKey } = event.headers || {};
      const { orderId, amount } = JSON.parse(event.body);

      if (!orderId || !amount) {
        return errorResponse('Missing required fields: orderId, amount', 400);
      }

      // Get the payment records for this order
      const payments = await db.queryItems('payments', {
        KeyConditionExpression: 'orderId = :orderId',
        ExpressionAttributeValues: {
          ':orderId': orderId
        }
      });

      if (payments.length === 0) {
        return errorResponse('No payment found for this order', 404);
      }

      const latestPayment = payments[payments.length - 1]; // Assuming last payment is the most recent
      const paymentInstance = Payment.fromDynamo(latestPayment);

      if (paymentInstance.status === 'FAILED') {
        return errorResponse('Cannot refund failed payment', 400);
      }

      const refundId = `refund-${Date.now()}`;
      const refund = new Payment({
        id: refundId,
        orderId,
        amount: -parseFloat(amount),
        status: 'REFUNDED',
        method: paymentInstance.method
      });

      await db.putItem('payments', refund.toDynamo());

      // Update order status
      await db.updateItem('orders', { id: orderId },
        'SET #status = :status, updatedAt = :now',
        {
          ':status': 'FAILED',
          ':now': new Date().toISOString(),
          '#status': 'status'
        }
      );

      return successResponse(refund);

    } catch (error) {
      return errorResponse('Failed to refund payment', 500, error);
    }
  }

  // Compensating action for saga orchestration
  static async refundPaymentForSaga(orderId) {
    try {
      // Get all payment records for this order
      const payments = await db.queryItems('payments', {
        KeyConditionExpression: 'orderId = :orderId',
        ExpressionAttributeValues: {
          ':orderId': orderId
        }
      });

      if (payments.length === 0) {
        return { success: false, error: 'No payment found for this order' };
      }

      // Find the last successful payment
      const successfulPayments = payments.filter(p => p.status === 'APPROVED');
      if (successfulPayments.length === 0) {
        return { success: false, error: 'No successful payment to refund' };
      }

      const latestPayment = successfulPayments[successfulPayments.length - 1];

      // Create refund record
      const refundId = `refund-${Date.now()}`;
      const refund = new Payment({
        id: refundId,
        orderId: orderId,
        amount: -latestPayment.amount, // Negative amount for refund
        status: 'REFUNDED',
        method: latestPayment.method
      });

      await db.putItem('payments', refund.toDynamo());

      // Update order status to indicate refund
      const Order = await import('../../../orders/models/Order.js');
      const orderData = await db.getItem('orders', { id: orderId });
      const orderInstance = Order.fromDynamo(orderData);

      if (!orderInstance.canCancel()) {
        return { success: false, error: 'Cannot refund: order in final state' };
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

      return { success: true, payment: refund };

    } catch (error) {
      return { success: false, error: error.message || error };
    }
  }
}