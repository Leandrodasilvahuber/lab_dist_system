import { api } from '../core/api.js';
import { emit } from '../core/events.js';

// Config de caos em vigor (GET /chaos). Compartilhada pela aba Caos e pela
// faixa de alerta do topo; cada carga avisa 'chaos'
export let chaosState = { enabled: false, active: false, faults: [] };

export async function loadChaos() {
    try {
        chaosState = await api('/chaos');
    } catch {
        // API antiga (sem /chaos) ou fora do ar: sem faixa, a aba mostra o erro
        chaosState = { enabled: false, active: false, faults: [], unavailable: true };
    }
    emit('chaos', chaosState);
    return chaosState;
}

export async function saveChaos({ faults, minutes }) {
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    chaosState = await api('/chaos', { method: 'PUT', body: JSON.stringify({ expiresAt, faults }) });
    emit('chaos', chaosState);
    return chaosState;
}

export async function clearChaos() {
    chaosState = await api('/chaos', { method: 'DELETE' });
    emit('chaos', chaosState);
    return chaosState;
}
