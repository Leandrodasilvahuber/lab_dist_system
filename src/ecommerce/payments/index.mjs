import { createServiceHandler } from '../../common/http-handler.mjs';
import { actions } from './src/actions.js';

/**
 * Payments não tem rotas HTTP: só executa as ações invocadas pela saga
 * (Step Functions), como processPayment e refundPayment.
 */
export const handler = createServiceHandler({ service: 'payments', actions });
