import { api, apiAll } from '../core/api.js';
import { storage } from '../core/storage.js';

export const getSaga = sagaId => api(`/saga/${encodeURIComponent(sagaId)}`);

export const listSagas = async () => (await apiAll('/sagas', 'sagas')).sagas;

// Compras feitas neste navegador. Sem a chave de admin, GET /sagas não está
// disponível: a tela de compra mostra só estas, consultadas uma a uma
const MY_SAGAS = 'mySagas';
const MY_SAGAS_MAX = 20;

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
