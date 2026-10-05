import { log } from './logger.mjs';
import { normalizeHttpEvent } from './http-event.mjs';
import { isActionInvocation, runAction, isDomainEvent, runEventHandler } from './actions.mjs';
import { errorResponse, notFoundResponse, sdkErrorResponse } from './response.mjs';
import { DependencyUnavailableError, DomainError } from './errors.mjs';
import { isTransientAwsError } from './aws-client.mjs';

// Leitura de algo que não existe (GET/HEAD com 404) não é erro de negócio: um
// cliente com bug ou um robô varrendo URLs dispararia o alarme business-errors.
// Vira linha info com a métrica ClientErrors, que a aba Métricas mostra à parte
function isClientMiss(method, statusCode) {
  return statusCode === 404 && (method === 'GET' || method === 'HEAD');
}

const CLIENT_MISS_METRICS = {
  metrics: { ClientErrors: { value: 1 } },
  dimensions: { ErrorType: 'HTTP_404' },
  dimensionSets: [[], ['ErrorType']]
};

function logRejection(event, correlationId, statusCode, message, extra) {
  const base = { event: 'API_REJECTED', correlationId, message: `${event.method} ${event.path} -> ${statusCode}: ${message}`, ...extra };
  if (isClientMiss(event.method, statusCode)) {
    log({ ...base, status: 'info', error: null, metrics: CLIENT_MISS_METRICS });
  } else {
    log({ ...base, status: 'warn' });
  }
}

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
      // warn, exceto leitura que não achou nada (logRejection). 5xx já foi
      // registrado como error por quem o gerou (sdkErrorResponse).
      const { statusCode } = response;
      const data = { method: event.method, path: event.path, statusCode, durationMs: Date.now() - started };
      if (statusCode >= 400 && statusCode < 500) {
        logRejection(event, correlationId, statusCode, errorMessage(response), { data });
      } else {
        log({ event: 'API_RESPONSE', correlationId, status: 'info', message: `${event.method} ${event.path} -> ${statusCode}`, data });
      }
      return response;
    } catch (error) {
      // Dependência fora do ar ou throttling/timeout da AWS: 503 com
      // Retry-After, como nos controllers
      if (error instanceof DependencyUnavailableError || isTransientAwsError(error)) {
        return sdkErrorResponse(error, `${event.method} ${event.path}`, correlationId);
      }
      // Erro de negócio lançado fora dos controllers (ex.: path mal codificado): 4xx, não alarme
      if (error instanceof DomainError) {
        logRejection(event, correlationId, error.statusCode, error.message, { error });
        return errorResponse(error.message, error.statusCode);
      }
      log({ event: 'API_ERROR', correlationId, status: 'error', message: 'API request error', error });
      return errorResponse('Internal server error', 500);
    }
  };
}
