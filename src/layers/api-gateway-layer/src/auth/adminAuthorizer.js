import { isValidApiKey } from '../../../../common/auth.mjs';

/**
 * Lambda authorizer do HttpApi (payload 2.0, respostas simples) para as rotas
 * administrativas. Compara o header X-Api-Key com ADMIN_API_KEY.
 */
export async function handler(event) {
  return { isAuthorized: isValidApiKey(event.headers, process.env.ADMIN_API_KEY) };
}
