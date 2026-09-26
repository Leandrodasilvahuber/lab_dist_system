export const EventTypes = {
  // Saga events
  SAGA_STARTED: 'SAGA_STARTED',
  SAGA_COMPLETED: 'SAGA_COMPLETED',
  SAGA_FAILED: 'SAGA_FAILED',
  SAGA_COMPENSATING: 'SAGA_COMPENSATING',
  SAGA_COMPENSATED: 'SAGA_COMPENSATED',

  // Order events
  ORDER_CREATED: 'ORDER_CREATED',
  ORDER_CONFIRMED: 'ORDER_CONFIRMED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',

  // Payment events
  PAYMENT_PROCESSED: 'PAYMENT_PROCESSED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',

  // Stock events
  STOCK_RESERVED: 'STOCK_RESERVED',
  STOCK_RELEASED: 'STOCK_RELEASED',
  STOCK_INSUFFICIENT: 'STOCK_INSUFFICIENT'
};

export const EventActions = {
  // Saga actions
  CREATE_ORDER: 'CREATE_ORDER',
  PROCESS_PAYMENT: 'PROCESS_PAYMENT',
  RESERVE_STOCK: 'RESERVE_STOCK',
  CONFIRM_ORDER: 'CONFIRM_ORDER',

  // Compensation actions
  CANCEL_ORDER: 'CANCEL_ORDER',
  REFUND_PAYMENT: 'REFUND_PAYMENT',
  RELEASE_STOCK: 'RELEASE_STOCK'
};

export const EventStatus = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  RETRYING: 'RETRYING'
};

export const EventSchemas = {
  [EventTypes.SAGA_STARTED]: {
    type: 'object',
    properties: {
      sagaId: { type: 'string' },
      orderId: { type: 'string' },
      correlationId: { type: 'string' },
      totalSteps: { type: 'number' }
    },
    required: ['sagaId', 'orderId', 'correlationId']
  },

  [EventTypes.SAGA_COMPLETED]: {
    type: 'object',
    properties: {
      sagaId: { type: 'string' },
      orderId: { type: 'string' },
      correlationId: { type: 'string' },
      totalTime: { type: 'number' },
      stepsCompleted: { type: 'number' }
    },
    required: ['sagaId', 'orderId', 'correlationId']
  },

  [EventTypes.SAGA_FAILED]: {
    type: 'object',
    properties: {
      sagaId: { type: 'string' },
      orderId: { type: 'string' },
      correlationId: { type: 'string' },
      failedStep: { type: 'string' },
      error: { type: 'string' },
      timestamp: { type: 'string' }
    },
    required: ['sagaId', 'orderId', 'correlationId']
  },

  [EventTypes.ORDER_CREATED]: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      productId: { type: 'string' },
      quantity: { type: 'number' },
      total: { type: 'number' },
      correlationId: { type: 'string' }
    },
    required: ['orderId', 'productId', 'quantity', 'total']
  },

  [EventTypes.PAYMENT_PROCESSED]: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      paymentId: { type: 'string' },
      amount: { type: 'number' },
      status: { type: 'string' },
      correlationId: { type: 'string' }
    },
    required: ['orderId', 'paymentId', 'amount', 'status']
  },

  [EventTypes.PAYMENT_FAILED]: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      amount: { type: 'number' },
      error: { type: 'string' },
      correlationId: { type: 'string' }
    },
    required: ['orderId', 'amount', 'error']
  },

  [EventTypes.STOCK_RESERVED]: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      productId: { type: 'string' },
      quantity: { type: 'number' },
      reservationId: { type: 'string' },
      correlationId: { type: 'string' }
    },
    required: ['orderId', 'productId', 'quantity', 'reservationId']
  },

  [EventTypes.STOCK_RELEASED]: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      productId: { type: 'string' },
      quantity: { type: 'number' },
      reservationId: { type: 'string' },
      correlationId: { type: 'string' }
    },
    required: ['orderId', 'productId', 'quantity', 'reservationId']
  }
};

export function validateEvent(eventType, eventData) {
  const schema = EventSchemas[eventType];
  if (!schema) {
    throw new Error(`Unknown event type: ${eventType}`);
  }

  // Basic validation - in production use a proper validator like ajv
  for (const requiredField of schema.required) {
    if (!(requiredField in eventData)) {
      throw new Error(`Missing required field: ${requiredField}`);
    }
  }

  return true;
}
