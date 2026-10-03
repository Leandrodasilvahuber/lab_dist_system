import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { isValidApiKey } from '../../../../common/auth.mjs';
import { log } from '../../../../common/logger.mjs';

// A chave é relida do SSM depois deste tempo (troca de chave sem redeploy).
// Curto de propósito: o HttpApi ainda guarda a decisão por chave recebida
// (ReauthorizeEvery: 300 no template), então a chave antiga vale por até
// CACHE_TTL + 300s depois da troca.
export const CACHE_TTL_MS = 60 * 1000;

/**
 * Lê a chave de admin de um parâmetro SecureString do SSM, com cache em memória.
 * A chave não fica em variável de ambiente da Lambda (visível no console).
 */
export function createKeyProvider({
  parameterName = process.env.ADMIN_API_KEY_PARAM,
  client = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' }),
  now = Date.now
} = {}) {
  let cached;
  return async function getAdminKey() {
    if (cached && cached.expiresAt > now()) return cached.value;
    if (!parameterName) throw new Error('ADMIN_API_KEY_PARAM is not configured');

    const { Parameter } = await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
    cached = { value: Parameter?.Value, expiresAt: now() + CACHE_TTL_MS };
    return cached.value;
  };
}

/**
 * Lambda authorizer do HttpApi (payload 2.0, respostas simples) para as rotas
 * administrativas. Compara o header X-Api-Key com a chave guardada no SSM.
 * Se a chave não puder ser lida, nega (falha fechada).
 */
export function createHandler(getAdminKey = createKeyProvider()) {
  return async function handler(event) {
    try {
      return { isAuthorized: isValidApiKey(event.headers, await getAdminKey()) };
    } catch (error) {
      log({ event: 'ADMIN_KEY_UNAVAILABLE', status: 'error', message: 'Could not read admin key', error });
      return { isAuthorized: false };
    }
  };
}

export const handler = createHandler();
