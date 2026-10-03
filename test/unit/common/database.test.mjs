import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from '../../../src/common/database.mjs';

describe('Database', () => {
  it('should create Database instance', () => {
    const db = new Database();
    assert.ok(db);
    assert.strictEqual(typeof db.getItem, 'function');
    assert.strictEqual(typeof db.putItem, 'function');
    assert.strictEqual(typeof db.updateItem, 'function');
    assert.strictEqual(typeof db.scanItems, 'function');
    assert.strictEqual(typeof db.queryItems, 'function');
  });
});
