import { StockSDK } from '../../../common/sdks/index.mjs';
import { eventBus } from '../../../common/event-bus.mjs';

const stockSDK = new StockSDK(eventBus);

// Ações invocadas pela saga (Step Functions)
export const actions = {
  reserveStock: ({ reservationId, productId, quantity, correlationId }) =>
    stockSDK.reserveStock({ id: reservationId, productId, quantity, correlationId }),

  releaseStock: ({ reservationId, correlationId }) =>
    stockSDK.releaseStock({ reservationId, correlationId })
};
