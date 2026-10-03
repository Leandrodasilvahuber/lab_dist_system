import { createServiceHandler } from '../../common/http-handler.mjs';
import { setupRoutes } from './src/routes/sagaRoutes.js';

export const handler = createServiceHandler({ setupRoutes });
