import { EventActions } from '../src/types/Events.js';

export const SagaDefinitions = {
  ORDER_SAGA: {
    name: 'ORDER_SAGA',
    version: '1.0',
    steps: [
      {
        name: 'createOrder',
        action: EventActions.CREATE_ORDER,
        service: 'orders',
        endpoint: '/orders',
        method: 'POST',
        compensationAction: EventActions.CANCEL_ORDER
      },
      {
        name: 'processPayment',
        action: EventActions.PROCESS_PAYMENT,
        service: 'payments',
        endpoint: '/payments',
        method: 'POST',
        compensationAction: EventActions.REFUND_PAYMENT
      },
      {
        name: 'reserveStock',
        action: EventActions.RESERVE_STOCK,
        service: 'stock',
        endpoint: '/stock/{productId}/reserve',
        method: 'POST',
        compensationAction: EventActions.RELEASE_STOCK
      },
      {
        name: 'confirmOrder',
        action: EventActions.CONFIRM_ORDER,
        service: 'orders',
        endpoint: '/orders/confirm',
        method: 'POST',
        compensationAction: EventActions.CANCEL_ORDER
      }
    ]
  },

  getOrderSaga(orderId) {
    return SagaDefinitions.ORDER_SAGA;
  }
};

export const RetryConfig = {
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
  RETRY_BACKOFF_FACTOR: 2
};

export const CompensationConfig = {
  MAX_COMPENSATION_RETRIES: 3,
  COMPENSATION_TIMEOUT_MS: 5000,
  COMPENSATION_DELAY_MS: 500
};
