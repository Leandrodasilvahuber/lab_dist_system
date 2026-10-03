import { PaymentSDK } from '../../../common/sdks/index.mjs';
import { eventBus } from '../../../common/event-bus.mjs';

const paymentSDK = new PaymentSDK(eventBus);

// Ações invocadas pela saga (Step Functions)
export const actions = {
  processPayment: ({ paymentId, orderId, amount, correlationId }) =>
    paymentSDK.processPayment({ id: paymentId, orderId, amount, correlationId }),

  refundPayment: ({ paymentId, correlationId }) =>
    paymentSDK.refundPaymentById(paymentId, undefined, correlationId)
};
