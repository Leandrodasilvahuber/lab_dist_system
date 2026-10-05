import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mapLimit } from '../../../scripts/lib/pool.mjs';

describe('mapLimit', () => {
  it('nunca passa do limite e mantém a ordem dos resultados', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([30, 5, 20, 1, 10], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, ms));
      running--;
      return i;
    });
    assert.strictEqual(peak, 2);
    assert.deepStrictEqual(results, [0, 1, 2, 3, 4]);
  });

  it('lista vazia não roda nada', async () => {
    assert.deepStrictEqual(await mapLimit([], 2, async () => { throw new Error('não deveria rodar'); }), []);
  });
});
