import { log } from '../../common/logger.mjs';
import { isActionInvocation, runAction } from '../../common/actions.mjs';
import { actions } from './src/actions.js';

/**
 * Payments não tem rotas HTTP: só executa as ações invocadas pela saga
 * (Step Functions), como processPayment e refundPayment.
 */
export async function handler(rawEvent) {
  if (isActionInvocation(rawEvent)) {
    return runAction(actions, rawEvent);
  }

  log({ event: 'UNSUPPORTED_INVOCATION', status: 'error', message: 'Payments only accepts saga actions' });
  return {
    statusCode: 404,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({ error: 'Not found' })
  };
}
