import { api, apiAll } from '../core/api.js';
import { API_BASE } from '../core/config.js';
import { storage } from '../core/storage.js';

export const getSaga = sagaId => api(`/saga/${encodeURIComponent(sagaId)}`);

export const listSagas = async () => (await apiAll('/sagas', 'sagas')).sagas;

// Compras feitas neste navegador. Sem a chave de admin, GET /sagas não está
// disponível: a tela de compra mostra só estas, consultadas uma a uma.
// Guardadas por API (?api=), como a chave de admin: as compras de outro
// ambiente dariam 404 aqui
const LEGACY_MY_SAGAS = 'mySagas';
const MY_SAGAS = `mySagas:${API_BASE}`;
const MY_SAGAS_MAX = 20;

// Versões antigas guardavam sem a API: a lista passa para a API aberta agora
// (o caso comum é usar uma só) e a cópia antiga é apagada
function migrateLegacy() {
    const legacy = storage.get(LEGACY_MY_SAGAS, null);
    if (!Array.isArray(legacy)) return;
    if (!storage.get(MY_SAGAS, null)) storage.set(MY_SAGAS, legacy.slice(0, MY_SAGAS_MAX));
    storage.remove(LEGACY_MY_SAGAS);
}
migrateLegacy();

export const mySagaIds = () => storage.get(MY_SAGAS, []);

export function rememberSaga(sagaId) {
    storage.set(MY_SAGAS, [sagaId, ...mySagaIds().filter(id => id !== sagaId)].slice(0, MY_SAGAS_MAX));
}

export function forgetSaga(sagaId) {
    storage.set(MY_SAGAS, mySagaIds().filter(id => id !== sagaId));
}

// orderId/paymentId/reservationId de uma saga são <prefixo>_<sagaId>
export function sagaIdFrom(id) {
    const match = /^(?:order|pay|res)_(saga_.+)$/.exec(id);
    return match ? match[1] : id;
}
