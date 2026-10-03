import { ProductSDK } from '../../../common/sdks/index.mjs';
import { eventBus } from '../../../common/event-bus.mjs';

const productSDK = new ProductSDK(eventBus);

// Ações invocadas diretamente por outros serviços (ex.: saga consulta preço)
export const actions = {
  getProduct: ({ productId }) => productSDK.getProduct(productId)
};
