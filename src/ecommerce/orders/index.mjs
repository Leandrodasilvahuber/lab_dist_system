import { createServiceHandler } from '../../common/http-handler.mjs';
import { setupRoutes } from './src/routes/orderRoutes.js';
import { actions } from './src/actions.js';

export const handler = createServiceHandler({ setupRoutes, actions });
