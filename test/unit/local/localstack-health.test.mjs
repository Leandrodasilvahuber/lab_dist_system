import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createLocalstackHealth, isCorruptedSchemaCache } from '../../../scripts/lib/localstack-health.mjs';

const CORRUPTED = Object.assign(new Error("exception while calling dynamodb.Query: 'arn:aws:dynamodb:us-east-1:000000000000:table/stock-reservations'"), { name: 'InternalError' });

describe('saúde do LocalStack', () => {
  it('reconhece só o erro do cache de tabelas', () => {
    assert.strictEqual(isCorruptedSchemaCache(CORRUPTED), true);
    assert.strictEqual(isCorruptedSchemaCache(new Error('connect ECONNREFUSED 127.0.0.1:4566')), false);
    assert.strictEqual(isCorruptedSchemaCache(new Error('Requested resource not found')), false);
  });

  it('avisa uma vez, de novo só depois de voltar ao normal', async () => {
    let failing = true;
    const warned = [];
    const recovered = [];
    const health = createLocalstackHealth({
      probe: async () => { if (failing) throw CORRUPTED; },
      warn: m => warned.push(m),
      info: m => recovered.push(m)
    });

    assert.strictEqual(await health.check(), true);
    await health.check();
    assert.strictEqual(warned.length, 1);
    assert.match(warned[0], /localstack:stop/);

    failing = false;
    assert.strictEqual(await health.check(), false);
    assert.strictEqual(recovered.length, 1);

    failing = true;
    await health.check();
    assert.strictEqual(warned.length, 2);
  });

  it('LocalStack fora do ar não é este defeito: não avisa', async () => {
    const warned = [];
    const health = createLocalstackHealth({ probe: async () => { throw new Error('ECONNREFUSED'); }, warn: m => warned.push(m) });
    assert.strictEqual(await health.check(), false);
    assert.strictEqual(warned.length, 0);
  });
});
