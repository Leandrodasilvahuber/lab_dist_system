import { createServiceHandler } from '../../common/http-handler.mjs';
import { setupRoutes } from './src/routes/stockRoutes.js';
import { actions, eventHandlers } from './src/actions.js';

export const handler = createServiceHandler({ setupRoutes, actions, eventHandlers });
