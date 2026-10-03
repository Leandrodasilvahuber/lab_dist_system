import { OrderSDK } from '../../../common/sdks/index.mjs';
import { eventBus } from '../../../common/event-bus.mjs';

const orderSDK = new OrderSDK(eventBus);

// Ações invocadas pela saga (Step Functions)
export const actions = {
  createOrder: ({ orderId, productId, quantity, unitPrice, correlationId }) =>
    orderSDK.createOrder({ id: orderId, productId, quantity, unitPrice, correlationId }),

  confirmOrder: ({ orderId, correlationId }) =>
    orderSDK.confirmOrder(orderId, correlationId),

  cancelOrder: ({ orderId, correlationId }) =>
    orderSDK.cancelOrder(orderId, correlationId)
};
