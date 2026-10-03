import { ValidationError } from './errors.mjs';
import { toNumber } from './validation.mjs';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/**
 * Lê `limit` e `nextToken` da query string das listagens públicas.
 * O token é o LastEvaluatedKey do DynamoDB em base64url, opaco para o cliente.
 */
export function parsePagination(query = {}) {
  const limit = query.limit === undefined ? DEFAULT_PAGE_SIZE : toNumber(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  return { limit, startKey: decodeToken(query.nextToken) };
}

export function encodeToken(lastKey) {
  return lastKey ? Buffer.from(JSON.stringify(lastKey)).toString('base64url') : undefined;
}

function decodeToken(token) {
  if (token === undefined || token === '') return undefined;
  try {
    const key = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    // Só a chave da tabela (id): atributos extras fariam o DynamoDB recusar o cursor
    if (key && typeof key === 'object' && !Array.isArray(key) && typeof key.id === 'string') return { id: key.id };
  } catch { /* token inválido */ }
  throw new ValidationError('Invalid nextToken');
}
