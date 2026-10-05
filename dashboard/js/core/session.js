import { emit } from './events.js';

// Chave de admin, enviada como X-Api-Key. Fica no sessionStorage (só nesta
// aba, some ao fechá-la), não no localStorage: um XSS ou outra pessoa no mesmo
// computador não acha a chave dias depois. Sem storage, vale até recarregar
const KEY = 'adminKey';

function read() {
    try {
        // Versões antigas guardavam no localStorage: apaga a cópia esquecida
        localStorage.removeItem(KEY);
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
