import { api, apiAll } from '../core/api.js';

export const getSaga = sagaId => api(`/saga/${encodeURIComponent(sagaId)}`);

export const listSagas = async () => (await apiAll('/sagas', 'sagas')).sagas;

// orderId/paymentId/reservationId de uma saga são <prefixo>_<sagaId>
export function sagaIdFrom(id) {
    const match = /^(?:order|pay|res)_(saga_.+)$/.exec(id);
    return match ? match[1] : id;
}
