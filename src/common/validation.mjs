import { ValidationError } from './errors.mjs';

// Limites dos textos livres: bem abaixo dos 400 KB de um item do DynamoDB, para
// que um texto grande seja 400 (validação) e não 500 (ValidationException do banco)
export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;

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
