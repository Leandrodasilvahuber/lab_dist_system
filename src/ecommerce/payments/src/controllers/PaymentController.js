import { PaymentSDK } from '../../../../common/sdks/index.mjs';
import { eventBus } from '../../../../common/event-bus.mjs';
import { successResponse, errorResponse, parseBody, sdkErrorResponse } from '../../../../common/response.mjs';

const paymentSDK = new PaymentSDK(eventBus);

export class PaymentController {
  /**
   * POST /payments
   */
  static async processPayment(event) {
    try {
      const { orderId, amount, correlationId } = parseBody(event);

      if (!orderId || amount === undefined) {
        return errorResponse('Missing required fields: orderId, amount', 400);
      }
      if (Number.isNaN(Number(amount)) || Number(amount) <= 0) {
        return errorResponse('Amount must be a positive number', 400);
      }

      const payment = await paymentSDK.processPayment({
        orderId,
        amount: Number(amount),
        correlationId
      });

      return successResponse(payment, 201);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to process payment');
    }
  }

  /**
   * POST /payments/refund
   */
  static async refundPayment(event) {
    try {
      const { transactionId, amount, correlationId } = parseBody(event);

      if (!transactionId) {
        return errorResponse('Missing required field: transactionId', 400);
      }

      const payment = await paymentSDK.refundPayment(transactionId, amount, correlationId);
      return successResponse(payment);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to refund payment');
    }
  }
}
