import { DomainError, ValidationError } from './errors.mjs';

export function successResponse(body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Idempotency-Key, X-Correlation-ID'
    },
    body: JSON.stringify(body)
  };
}

export function errorResponse(message, statusCode = 500, error = null) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true
    },
    body: JSON.stringify({
      error: message,
      details: error ? error.message || error : undefined
    })
  };
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
 * Converte erros lançados pelos SDKs no status HTTP adequado
 */
export function sdkErrorResponse(error, fallbackMessage) {
  if (error instanceof DomainError) {
    return errorResponse(error.message, error.statusCode);
  }
  return errorResponse(fallbackMessage, 500, error);
}
