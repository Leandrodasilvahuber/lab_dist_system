import { ValidationError } from './errors.mjs';

// Limites dos textos livres: bem abaixo dos 400 KB de um item do DynamoDB, para
// que um texto grande seja 400 (validação) e não 500 (ValidationException do banco)
export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;

// Ids que viram chave do DynamoDB (produto, pedido, saga). A chave aceita até
// 2048 bytes: acima disso o banco responde ValidationException, que seria 500
// e, na consulta ao Products pela saga, contaria como queda no circuit breaker
// (bastariam algumas requisições públicas para abri-lo). Bem acima de qualquer
// id gerado (prod_<uuid>, saga_<48 hex>)
export const MAX_ID_LENGTH = 128;

/**
 * Confere um id vindo do cliente (path, body, query): string não vazia de até
 * MAX_ID_LENGTH caracteres. Lança ValidationError (400).
 */
export function requireId(value, field = 'id') {
  if (typeof value !== 'string' || !value || value.length > MAX_ID_LENGTH) {
    throw new ValidationError(`${field} must be a non-empty string with at most ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

/**
 * Converte um campo numérico vindo do JSON. Aceita número ou string numérica
 * não vazia; qualquer outra coisa (boolean, null, '', objeto) vira NaN, para
 * que `Number(true) === 1` ou `Number('') === 0` não passem como valores válidos.
 */
export function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/**
 * Arredonda um valor monetário para centavos. Evita que a aritmética de ponto
 * flutuante gere totais como 19.99 * 3 = 59.970000000000006.
 */
export function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Filtro numérico opcional da query string: ausente ou vazio vira undefined;
 * qualquer valor não numérico é rejeitado (em vez de ignorado em silêncio).
 */
export function optionalNumber(value, field) {
  if (value === undefined || value === '') return undefined;
  const number = toNumber(value);
  if (!Number.isFinite(number)) {
    throw new ValidationError(`${field} must be a number`);
  }
  return number;
}

/**
 * Janela em horas da query string (`?hours=`), em horas inteiras entre 1 e
 * `max`; ausente ou inválida vira `fallback`. Inteira porque é a chave do
 * cache das consultas: com frações (1.0001, 1.0002...) cada pedido furaria o
 * cache e o Map cresceria sem limite. Assim há no máximo `max` chaves.
 */
export function parseHours(raw, { fallback = 24, max }) {
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(Math.max(1, Math.round(hours)), max);
}
