import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Rotas administrativas: exigem o header X-Api-Key com a chave de admin.
 * Na AWS quem aplica é o authorizer do HttpApi (template.yaml, Auth.Authorizer
 * em cada rota); o local-server usa esta mesma lista. Mantenha os dois iguais.
 */
export const ADMIN_ROUTES = [
  // Escritas da aba Admin: cadastrar e remover produto, e o ajuste de
  // estoque (cria inventário). As leituras (pedidos, compras, métricas, a
  // lista da DLQ) são abertas, como pede o laboratório
  ['POST', /^\/products$/],
  ['DELETE', /^\/products\/[^/]+$/],
  ['POST', /^\/stock\/[^/]+\/adjust$/],
  // Ligar e desligar a injeção de falhas (GET /chaos fica aberto, como as leituras)
  ['PUT', /^\/chaos$/],
  ['DELETE', /^\/chaos$/],
  // Reprocessar e descartar eventos da DLQ: descartar perde o evento de vez
  // (o inventário do produto nunca seria criado ou removido)
  ['POST', /^\/dlq\/[^/]+\/(?:redrive|discard)$/],
  // Gasto da conta AWS inteira (Cost Explorer), não só desta stack, e a
  // leitura sob demanda dele (cada uma custa US$ 0,02)
  ['GET', /^\/metrics\/cost$/],
  ['POST', /^\/metrics\/cost\/refresh$/],
  // Logs e rastreio: as linhas internas das Lambdas (erros, ids, dados das
  // compras) e a leitura mais cara da observabilidade (segundos de Lambda
  // por consulta ao CloudWatch Logs)
  ['GET', /^\/logs$/],
  ['GET', /^\/trace\/[^/]+$/]
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
