import { describe, it } from 'node:test';
import assert from 'node:assert';

// localStorage mínimo do navegador
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key)
  };
}

// Página aberta em http://localhost:3001 com uma lista da versão antiga.
// config.js lê a API de location ao carregar: os globais vêm antes do import
// (cada arquivo de teste roda no seu processo)
async function loadSagas(storage) {
  globalThis.location = { search: '', protocol: 'http:', origin: 'http://localhost:3001' };
  globalThis.localStorage = storage;
  return import('../../../dashboard/js/services/sagas.js');
}

describe('dashboard: compras deste navegador', () => {
  it('guarda a lista por API e migra a lista antiga para a API aberta', async () => {
    const storage = fakeStorage({ mySagas: JSON.stringify(['saga_antiga']) });
    const sagas = await loadSagas(storage);

    assert.deepStrictEqual(sagas.mySagaIds(), ['saga_antiga']);
    assert.strictEqual(storage.data.has('mySagas'), false);

    sagas.rememberSaga('saga_nova');
    assert.deepStrictEqual(JSON.parse(storage.data.get('mySagas:http://localhost:3001')), ['saga_nova', 'saga_antiga']);
  });
});
