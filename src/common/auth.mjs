import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Rotas administrativas: exigem o header X-Api-Key com a chave de admin.
 * Na AWS quem aplica é o authorizer do HttpApi (template.yaml, Auth.Authorizer
 * em cada rota); o local-server usa esta mesma lista. Mantenha os dois iguais.
 */
export const ADMIN_ROUTES = [
  ['POST', /^\/products$/],
  ['POST', /^\/stock\/[^/]+\/adjust$/],
  // Listagens de todas as compras e pedidos (o cliente consulta as suas por id)
  ['GET', /^\/orders$/],
  ['GET', /^\/sagas$/],
  // Logs têm ids, correlationId e mensagens internas
  ['GET', /^\/logs$/],
  // Alarmes: nomes e descrições internas, e o motivo traz os valores das métricas
  ['GET', /^\/alarms$/],
  // Métricas da saga: ids das compras e erros internos de cada passo
  ['GET', /^\/metrics\/sagas$/],
  // DLQ: o body tem dados do produto e as ações mudam estado
  ['GET', /^\/dlq$/],
  ['POST', /^\/dlq\/[^/]+\/(redrive|discard)$/]
];

export function isAdminRoute(method, path) {
  return ADMIN_ROUTES.some(([m, pattern]) => m === method && pattern.test(path));
}

const digest = value => createHash('sha256').update(String(value)).digest();

/**
 * Compara a chave recebida com a esperada em tempo constante.
 * Sem chave configurada, nega tudo (falha fechada).
 */
export function isValidApiKey(headers = {}, expectedKey) {
  if (!expectedKey) return false;
  const received = receivedApiKey(headers);
  if (!received) return false;
  return timingSafeEqual(digest(received), digest(expectedKey));
}

function receivedApiKey(headers) {
  const received = headers['x-api-key'] ?? headers['X-Api-Key'];
  return typeof received === 'string' && received ? received : undefined;
}

// Hash da chave de admin para o .env do local-server (npm run admin:hash).
// Só local: na AWS a chave fica no SSM (SecureString) e o authorizer usa isValidApiKey,
// sem pagar o custo do scrypt a cada chave recebida.
const SCRYPT_KEY_LENGTH = 32;
const scryptAsync = promisify(scrypt);
const HEX = /^(?:[0-9a-f]{2})+$/i;

/** Devolve `scrypt$<salt hex>$<hash hex>`, com salt aleatório. */
export function hashApiKey(key) {
  if (typeof key !== 'string' || !key) throw new Error('A chave não pode ser vazia');
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(key, salt, SCRYPT_KEY_LENGTH).toString('hex')}`;
}

/**
 * Compara a chave recebida com um hash gerado por hashApiKey.
 * Hash ausente ou mal formado nega tudo (falha fechada). O scrypt (~100 ms) roda
 * na threadpool, sem travar o servidor, e só depois de conferir formato e header.
 */
export async function isValidApiKeyHash(headers = {}, storedHash) {
  const [scheme, saltHex, hashHex, ...rest] = typeof storedHash === 'string' ? storedHash.split('$') : [];
  if (scheme !== 'scrypt' || !HEX.test(saltHex ?? '') || !HEX.test(hashHex ?? '') || rest.length) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== SCRYPT_KEY_LENGTH) return false;

  const received = receivedApiKey(headers);
  if (!received) return false;
  return timingSafeEqual(await scryptAsync(received, Buffer.from(saltHex, 'hex'), SCRYPT_KEY_LENGTH), expected);
}
