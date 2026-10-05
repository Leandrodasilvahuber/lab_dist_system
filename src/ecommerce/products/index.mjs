import { createServiceHandler } from '../../common/http-handler.mjs';
import { setupRoutes } from './src/routes/productRoutes.js';
import { actions } from './src/actions.js';

export const handler = createServiceHandler({ service: 'products', setupRoutes, actions });
