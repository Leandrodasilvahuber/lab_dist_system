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
