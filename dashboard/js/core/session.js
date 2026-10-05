import { API_BASE } from './config.js';
import { emit } from './events.js';

// Chave de admin, enviada como X-Api-Key. Fica no sessionStorage (só nesta
// aba, some ao fechá-la), não no localStorage: um XSS ou outra pessoa no mesmo
// computador não acha a chave dias depois. Sem storage, vale até recarregar.
// Guardada por API (?api=): um link para o dashboard com outra API, aberto na
// mesma aba, começa sem chave em vez de mandá-la para aquele endereço
const LEGACY_KEY = 'adminKey';
const KEY = `adminKey:${API_BASE}`;

function read() {
    try {
        // Versões antigas guardavam sem a API (no localStorage e depois no
        // sessionStorage): apaga as cópias, que valeriam para qualquer API
        localStorage.removeItem(LEGACY_KEY);
        sessionStorage.removeItem(LEGACY_KEY);
    } catch { /* sem storage */ }
    try { return JSON.parse(sessionStorage.getItem(KEY)) ?? ''; } catch { return ''; }
}

let adminKey = read();

export const getAdminKey = () => adminKey;

export function setAdminKey(value) {
    adminKey = value;
    try {
        if (adminKey) sessionStorage.setItem(KEY, JSON.stringify(adminKey));
        else sessionStorage.removeItem(KEY);
    } catch { /* sem storage: só até recarregar */ }
    emit('admin', adminKey);
}
