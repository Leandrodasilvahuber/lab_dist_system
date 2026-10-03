import { log } from './logger.mjs';
import { normalizeHttpEvent } from './http-event.mjs';
import { isActionInvocation, runAction, isDomainEvent, runEventHandler } from './actions.mjs';
import { errorResponse, notFoundResponse } from './response.mjs';

/**
 * Handler padrão das Lambdas de serviço. Atende os três tipos de invocação:
 *  - ação da saga (Step Functions): { action, input }
 *  - evento de domínio (EventBridge): { source, detail-type, detail }
 *  - requisição HTTP (HttpApi), roteada por `setupRoutes`
 */
export function createServiceHandler({ setupRoutes, actions = {}, eventHandlers = {} }) {
  return async function handler(rawEvent) {
    if (isActionInvocation(rawEvent)) {
      return runAction(actions, rawEvent);
    }
    if (isDomainEvent(rawEvent)) {
      return runEventHandler(eventHandlers, rawEvent);
    }

    const event = normalizeHttpEvent(rawEvent);
    const { correlationId } = event.headers;

    if (!setupRoutes) {
      log({ event: 'UNSUPPORTED_INVOCATION', correlationId, status: 'error', message: 'Service only accepts saga actions' });
      return notFoundResponse(event.path);
    }

    try {
      log({ event: 'API_REQUEST', correlationId, status: 'info', message: `Incoming request: ${event.httpMethod} ${event.path}` });
      const response = await setupRoutes(event);
      log({ event: 'API_RESPONSE', correlationId, status: 'info', message: `Response status: ${response.statusCode}` });
      return response;
    } catch (error) {
      log({ event: 'API_ERROR', correlationId, status: 'error', message: 'API request error', error });
      return errorResponse('Internal server error', 500);
    }
  };
}
