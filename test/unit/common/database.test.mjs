import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database, { sendRead } from '../../../src/common/database.mjs';

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

describe('sendRead', () => {
  const staleSocket = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  const fakeClient = failures => {
    const client = { calls: 0, send: async () => {
      client.calls++;
      const failure = failures.shift();
      if (failure) throw failure;
      return { Items: [] };
    } };
    return client;
  };

  it('repete a leitura quando o socket reaproveitado do pool morreu', async () => {
    const client = fakeClient([staleSocket(), Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })]);
    assert.deepStrictEqual(await sendRead(client, {}), { Items: [] });
    assert.strictEqual(client.calls, 3);
  });

  it('desiste depois de duas repetições', async () => {
    const client = fakeClient([staleSocket(), staleSocket(), staleSocket()]);
    await assert.rejects(sendRead(client, {}), { code: 'EPIPE' });
    assert.strictEqual(client.calls, 3);
  });

  it('não repete timeout nem throttling (quem repete é a camada de cima)', async () => {
    for (const error of [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), Object.assign(new Error('slow down'), { name: 'ThrottlingException' })]) {
      const client = fakeClient([error]);
      await assert.rejects(sendRead(client, {}), { name: error.name });
      assert.strictEqual(client.calls, 1);
    }
  });
});
