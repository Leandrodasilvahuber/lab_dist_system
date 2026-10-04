import { ValidationError } from './errors.mjs';

/**
 * Normaliza eventos de entrada das Lambdas.
 *
 * Converte o payload 2.0 do HttpApi (requestContext.http.method, rawPath) na forma
 * usada pelas rotas: method, path sem o prefixo do stage, headers em minúsculas,
 * query e body decodificado do base64.
 */
export function normalizeHttpEvent(event = {}) {
  const http = event.requestContext?.http;
  const stage = event.requestContext?.stage;

  let path = event.rawPath ?? http?.path ?? '/';
  // Em stages nomeados (ex.: "dev") o rawPath vem como /dev/products (ou só /dev)
  if (stage && stage !== '$default') {
    if (path === `/${stage}`) path = '/';
    else if (path.startsWith(`/${stage}/`)) path = path.slice(stage.length + 1);
  }

  let body = event.body ?? null;
  if (body && event.isBase64Encoded) {
    body = Buffer.from(body, 'base64').toString('utf8');
  }

  // Headers em minúsculas (como no HttpApi), mais o correlationId usado nos logs
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([name, value]) => [name.toLowerCase(), value])
  );

  return {
    ...event,
    method: http?.method,
    path,
    headers: {
      ...headers,
      correlationId: headers['x-correlation-id'] ?? headers.correlationid
    },
    queryStringParameters: event.queryStringParameters || {},
    body
  };
}

/**
 * Decodifica um segmento do path (ex.: id em /products/{id}). Encoding
 * inválido (ex.: %E0) é erro do cliente: 400, não URIError/500.
 */
export function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ValidationError('Invalid URL encoding in path');
  }
}
