import { successResponse, errorResponse } from '../shared/response.mjs';

export function authMiddleware(event) {
  const headers = event.headers || {};
  const authorization = headers.Authorization || headers.authorization;

  // Verificar se há token JWT básico
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return {
      statusCode: 401,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Unauthorized',
        message: 'Missing or invalid authorization header'
      })
    };
  }

  const token = authorization.substring(7);

  // Validação básica - em produção usar serviço de autenticação
  if (token !== 'mock-token') {
    return {
      statusCode: 401,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Unauthorized',
        message: 'Invalid token'
      })
    };
  }

  // Adicionar usuário ao event para uso nos controllers
  event.user = { id: 'user-123', email: 'user@example.com' };

  return null; // Prosseguir para o handler
}