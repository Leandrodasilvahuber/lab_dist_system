/**
 * Normaliza eventos de entrada das Lambdas.
 *
 * O HttpApi envia o payload no formato 2.0 (requestContext.http.method, rawPath),
 * enquanto as rotas foram escritas para o formato 1.0 (httpMethod, path).
 * Esta função preenche os campos do formato 1.0 a partir do 2.0, remove o prefixo
 * do stage do path e decodifica bodies em base64.
 */
export function normalizeHttpEvent(event = {}) {
  const http = event.requestContext?.http;
  const stage = event.requestContext?.stage;

  let path = event.path ?? event.rawPath ?? http?.path ?? '/';
  // Em stages nomeados (ex.: "dev") o rawPath vem como /dev/products
  if (stage && stage !== '$default' && path.startsWith(`/${stage}/`)) {
    path = path.slice(stage.length + 1);
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
    httpMethod: event.httpMethod ?? http?.method,
    path,
    headers: {
      ...headers,
      correlationId: headers['x-correlation-id'] ?? headers.correlationid
    },
    queryStringParameters: event.queryStringParameters || {},
    body
  };
}
