import { log } from './logger.mjs';
import { normalizeHttpEvent } from './http-event.mjs';
import { isActionInvocation, runAction, isDomainEvent, runEventHandler } from './actions.mjs';
import { errorResponse, notFoundResponse } from './response.mjs';
import { DomainError } from './errors.mjs';

function errorMessage(response) {
  try {
    return JSON.parse(response.body).error ?? '';
  } catch {
    return '';
  }
}

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

    const started = Date.now();
    try {
      const response = await setupRoutes(event);
      // Uma linha por request. 4xx = erro tratado (validação/regra de negócio):
      // warn. 5xx já foi registrado como error por quem o gerou (sdkErrorResponse).
      const { statusCode } = response;
      const data = { method: event.method, path: event.path, statusCode, durationMs: Date.now() - started };
      if (statusCode >= 400 && statusCode < 500) {
        log({ event: 'API_REJECTED', correlationId, status: 'warn', message: `${event.method} ${event.path} -> ${statusCode}: ${errorMessage(response)}`, data });
      } else {
        log({ event: 'API_RESPONSE', correlationId, status: 'info', message: `${event.method} ${event.path} -> ${statusCode}`, data });
      }
      return response;
    } catch (error) {
      // Erro de negócio lançado fora dos controllers (ex.: path mal codificado): 4xx, não alarme
      if (error instanceof DomainError) {
        log({ event: 'API_REJECTED', correlationId, status: 'warn', message: `${event.method} ${event.path} -> ${error.statusCode}: ${error.message}`, error });
        return errorResponse(error.message, error.statusCode);
      }
      log({ event: 'API_ERROR', correlationId, status: 'error', message: 'API request error', error });
      return errorResponse('Internal server error', 500);
    }
  };
}
