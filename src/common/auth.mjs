import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Rotas administrativas: exigem o header X-Api-Key com a chave de admin.
 * Na AWS quem aplica é o authorizer do HttpApi (template.yaml, Auth.Authorizer
 * em cada rota); o local-server usa esta mesma lista. Mantenha os dois iguais.
 */
export const ADMIN_ROUTES = [
  ['POST', /^\/products$/],
  ['POST', /^\/stock\/[^/]+\/adjust$/]
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
  const received = headers['x-api-key'] ?? headers['X-Api-Key'];
  if (typeof received !== 'string' || !received) return false;
  return timingSafeEqual(digest(received), digest(expectedKey));
}
