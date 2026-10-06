import { OrderSDK } from '../../../common/sdks/index.mjs';
import { eventBus } from '../../../common/event-bus.mjs';

const orderSDK = new OrderSDK(eventBus);

// Ações invocadas pela saga (Step Functions)
export const actions = {
  createOrder: ({ orderId, productId, quantity, unitPrice, correlationId }) =>
    orderSDK.createOrder({ id: orderId, productId, quantity, unitPrice, correlationId }),

  confirmOrder: ({ orderId, correlationId }) =>
    orderSDK.confirmOrder(orderId, correlationId),

  // compensation: SKIPPED quando o pedido nunca existiu (registro anulado)
  cancelOrder: async ({ orderId, correlationId }) => {
    const order = await orderSDK.cancelOrder(orderId, correlationId);
    return { ...order, compensation: order.status === 'voided' ? 'SKIPPED' : 'COMPENSATED' };
  }
};
