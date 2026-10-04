import { StockSDK } from '../../../common/sdks/index.mjs';
import { eventBus } from '../../../common/event-bus.mjs';

const stockSDK = new StockSDK(eventBus);

// Ações invocadas pela saga (Step Functions)
export const actions = {
  reserveStock: ({ reservationId, productId, quantity, correlationId }) =>
    stockSDK.reserveStock({ id: reservationId, productId, quantity, correlationId }),

  commitReservation: ({ reservationId, correlationId }) =>
    stockSDK.commitReservation({ reservationId, correlationId }),

  releaseStock: ({ reservationId, correlationId }) =>
    stockSDK.releaseStock({ reservationId, correlationId })
};

// Eventos de domínio recebidos do EventBridge (chave: <source>/<detail-type>)
export const eventHandlers = {
  'products/ProductCreated': ({ productId, name, initialStock, correlationId }) =>
    stockSDK.initializeStock({ productId, name, initialStock, correlationId }),

  'products/ProductDeleted': ({ productId }) =>
    stockSDK.removeInventory({ productId })
};
