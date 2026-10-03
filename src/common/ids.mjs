import { randomUUID } from 'node:crypto';

/**
 * Id único com prefixo legível (ex.: prod_3f2c...), usado por todos os serviços.
 */
export function generateId(prefix) {
  return `${prefix}_${randomUUID()}`;
}
