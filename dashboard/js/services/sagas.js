import { api } from '../core/api.js';

export const getSaga = sagaId => api(`/saga/${encodeURIComponent(sagaId)}`);

// As mais recentes (últimas 24 h) pelo índice por dia: uma requisição, sem
// percorrer a tabela inteira (GET /sagas paginado)
export const recentSagas = async (limit = 20) => (await api(`/sagas?recent=${limit}`)).sagas;

// orderId/paymentId/reservationId de uma saga são <prefixo>_<sagaId>
export function sagaIdFrom(id) {
    const match = /^(?:order|pay|res)_(saga_.+)$/.exec(id);
    return match ? match[1] : id;
}
