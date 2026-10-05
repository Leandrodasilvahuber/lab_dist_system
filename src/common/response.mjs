import { DomainError, DependencyUnavailableError, ValidationError } from './errors.mjs';
import { log } from './logger.mjs';
import { isTransientAwsError } from './aws-client.mjs';

// CORS na AWS: o HttpApi responde o preflight (OPTIONS) e sobrescreve estes
// headers com os da CorsConfiguration do template.yaml (origem via parâmetro
// AllowedOrigin). Eles só valem no local-server e em invocações diretas da
// Lambda; CORS_ALLOW_ORIGIN não tem efeito na AWS.
// Sem Access-Control-Allow-Credentials: a API não usa cookies (a chave de admin
// vai no header X-Api-Key), e o navegador recusa Allow-Credentials junto com
// Allow-Origin '*'.
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, Idempotency-Key, X-Idempotency-Key, X-Correlation-ID',
  // Sem isto o navegador esconde o Retry-After do 503 do JavaScript da página
  'Access-Control-Expose-Headers': 'Retry-After'
};

function jsonResponse(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...headers },
    body: JSON.stringify(body)
  };
}

export function successResponse(body, statusCode = 200) {
  return jsonResponse(statusCode, body);
}

/**
 * Resposta de erro. Só a mensagem vai para o cliente: detalhes internos
 * (mensagem da exceção, stack) ficam apenas no log.
 */
export function errorResponse(message, statusCode = 500, headers) {
  return jsonResponse(statusCode, { error: message }, headers);
}

export function notFoundResponse(path, extra = {}) {
  return jsonResponse(404, { error: 'Not found', path, ...extra });
}

/**
 * Faz o parse do body JSON; lança ValidationError se for inválido
 */
export function parseBody(event) {
  if (!event.body) return {};

  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  return body;
}

/**
 * Converte erros lançados pelos SDKs no status HTTP adequado.
 * `correlationId` liga a linha de log ao trace da requisição (GET /trace/{id}).
 */
export function sdkErrorResponse(error, fallbackMessage, correlationId) {
  // Throttling/timeout da AWS: mesma resposta de uma dependência fora do ar
  if (isTransientAwsError(error)) {
    error = new DependencyUnavailableError(undefined, { cause: error });
  }
  // Dependência fora do ar: 503 com Retry-After (o cliente pode repetir com a
  // mesma Idempotency-Key). A falha observada nesta requisição (com `cause`) é
  // de infraestrutura: error. Sem `cause` a dependência nem foi chamada
  // (circuito aberto): a abertura já foi registrada como error
  // (CIRCUIT_STATE_CHANGED, alarme circuit-open), então cada recusa é só info
  if (error instanceof DependencyUnavailableError) {
    if (!error.logged) {
      const message = `${fallbackMessage}: ${error.message}`;
      log(error.cause
        ? { event: 'DEPENDENCY_UNAVAILABLE', correlationId, status: 'error', message, error: error.cause }
        : { event: 'DEPENDENCY_UNAVAILABLE', correlationId, status: 'info', message });
    }
    return errorResponse(error.message, 503, { 'Retry-After': String(error.retryAfterSeconds) });
  }
  if (error instanceof DomainError) {
    return errorResponse(error.message, error.statusCode);
  }
  log({ event: 'UNEXPECTED_ERROR', correlationId, status: 'error', message: fallbackMessage, error });
  return errorResponse(fallbackMessage, 500);
}
