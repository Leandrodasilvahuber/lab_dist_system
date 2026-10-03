import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parsePagination, encodeToken, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../../src/common/pagination.mjs';
import { ValidationError } from '../../../src/common/errors.mjs';

const token = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

describe('parsePagination', () => {
  it('usa o tamanho padrão e nenhum cursor', () => {
    assert.deepStrictEqual(parsePagination({}), { limit: DEFAULT_PAGE_SIZE, startKey: undefined });
  });

  it('o token gerado volta como a mesma chave', () => {
    assert.deepStrictEqual(parsePagination({ limit: '10', nextToken: encodeToken({ id: 'p1' }) }), { limit: 10, startKey: { id: 'p1' } });
  });

  it('descarta atributos extras do cursor (só a chave id)', () => {
    assert.deepStrictEqual(parsePagination({ nextToken: token({ id: 'p1', price: 1 }) }).startKey, { id: 'p1' });
  });

  it('recusa limit fora do intervalo ou não inteiro', () => {
    for (const limit of ['0', String(MAX_PAGE_SIZE + 1), '2.5', 'abc']) {
      assert.throws(() => parsePagination({ limit }), ValidationError, limit);
    }
  });

  it('recusa token inválido', () => {
    for (const nextToken of ['abc', token({ id: 5 }), token([1]), token(null)]) {
      assert.throws(() => parsePagination({ nextToken }), ValidationError, nextToken);
    }
  });
});
