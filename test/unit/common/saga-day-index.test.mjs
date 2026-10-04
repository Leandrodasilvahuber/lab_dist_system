import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SAGA_DAY_SHARDS, sagaDayShard, dayShardsInWindow } from '../../../src/common/saga-day-index.mjs';

const HOUR = 60 * 60 * 1000;

describe('sagaDayShard', () => {
  it('dia em UTC e shard estável dentro de [0, N)', () => {
    const key = sagaDayShard('saga_abc', '2026-10-04T23:59:59.000Z');
    assert.match(key, /^2026-10-04#\d+$/);
    assert.strictEqual(sagaDayShard('saga_abc', '2026-10-04T00:00:00.000Z'), key);
    const shard = Number(key.split('#')[1]);
    assert.ok(shard >= 0 && shard < SAGA_DAY_SHARDS);
  });

  it('espalha ids diferentes pelos shards', () => {
    const shards = new Set(Array.from({ length: 200 }, (_, i) => sagaDayShard(`saga_${i}`, '2026-10-04T12:00:00Z').split('#')[1]));
    assert.strictEqual(shards.size, SAGA_DAY_SHARDS);
  });
});

describe('dayShardsInWindow', () => {
  it('janela dentro do mesmo dia: só os shards dele', () => {
    const now = Date.UTC(2026, 9, 4, 12);
    const keys = dayShardsInWindow(now - HOUR, now);
    assert.strictEqual(keys.length, SAGA_DAY_SHARDS);
    assert.ok(keys.every(key => key.startsWith('2026-10-04#')));
  });

  it('cruza o fim do mês e inclui o primeiro e o último dia', () => {
    const now = Date.UTC(2026, 9, 1, 1);
    const keys = dayShardsInWindow(now - 2 * HOUR, now);
    assert.deepStrictEqual([...new Set(keys.map(key => key.split('#')[0]))], ['2026-09-30', '2026-10-01']);
  });
});
