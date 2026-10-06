import { PaymentSDK } from '../../../common/sdks/index.mjs';
import { eventBus } from '../../../common/event-bus.mjs';

const paymentSDK = new PaymentSDK(eventBus);

// Ações invocadas pela saga (Step Functions)
export const actions = {
  processPayment: ({ paymentId, orderId, amount, correlationId }) =>
    paymentSDK.processPayment({ id: paymentId, orderId, amount, correlationId }),

  // compensation: SKIPPED quando não havia cobrança a desfazer (recusado, anulado)
  refundPayment: async ({ paymentId, correlationId }) => {
    const payment = await paymentSDK.refundPaymentById(paymentId, undefined, correlationId);
    return { ...payment, compensation: payment.status === 'refunded' ? 'COMPENSATED' : 'SKIPPED' };
  }
};
