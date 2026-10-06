import { API_BASE } from './config.js';
import { emit } from './events.js';
import { loadAuthConfig, refresh } from './cognito.js';

// Credencial de admin: { type: 'key', value } (X-Api-Key, local-server) ou
// { type: 'cognito', username, accessToken, refreshToken, expiresAt } (AWS).
// Fica no sessionStorage (só nesta aba, some ao fechá-la), não no
// localStorage: um XSS ou outra pessoa no mesmo computador não acha a
// credencial dias depois. Sem storage, vale até recarregar.
// Guardada por API (?api=): um link para o dashboard com outra API, aberto na
// mesma aba, começa sem credencial em vez de mandá-la para aquele endereço
const LEGACY_KEY = 'adminKey';
const KEY = `adminKey:${API_BASE}`;

// Renova o access token um pouco antes de expirar (relógio do navegador adiantado)
const REFRESH_MARGIN_MS = 60 * 1000;

function parse(stored) {
    // Versões anteriores guardavam a chave como texto
    if (typeof stored === 'string') return stored ? { type: 'key', value: stored } : null;
    if (stored?.type === 'key' && stored.value) return stored;
    if (stored?.type === 'cognito' && stored.accessToken && stored.refreshToken) return stored;
    return null;
}

function read() {
    try {
        // Versões antigas guardavam sem a API (no localStorage e depois no
        // sessionStorage): apaga as cópias, que valeriam para qualquer API
        localStorage.removeItem(LEGACY_KEY);
        sessionStorage.removeItem(LEGACY_KEY);
    } catch { /* sem storage */ }
    try { return parse(JSON.parse(sessionStorage.getItem(KEY))); } catch { return null; }
}

let credential = read();

export const getCredential = () => credential;
export const isAdmin = () => Boolean(credential);

function store() {
    try {
        if (credential) sessionStorage.setItem(KEY, JSON.stringify(credential));
        else sessionStorage.removeItem(KEY);
    } catch { /* sem storage: só até recarregar */ }
}

/** Entra (ou sai, com null) do modo admin e avisa as telas. */
export function setCredential(value) {
    credential = parse(value);
    store();
    emit('admin', credential);
}

let refreshing;

// Um refresh por vez: várias requisições em paralelo esperam o mesmo
async function refreshed(current) {
    refreshing ??= loadAuthConfig()
        .then(config => {
            if (config.mode !== 'cognito') throw new Error('API sem login pelo Cognito');
            return refresh(config, current.refreshToken);
        })
        .then(tokens => {
            // Saiu (ou entrou com outra conta) durante o refresh: descarta
            if (credential !== current) return credential;
            credential = { ...current, ...tokens };
            store();
            return credential;
        })
        .catch(error => {
            // Refresh token expirado ou revogado: sai do modo admin. Outra
            // falha (rede, limite do Cognito) mantém a sessão: a API responde 401
            if (error.code === 'NotAuthorizedException' && credential === current) setCredential(null);
            return credential;
        })
        .finally(() => { refreshing = undefined; });
    return refreshing;
}

/**
 * Headers de autenticação da próxima requisição. Com o Cognito, renova o
 * access token se estiver perto de expirar (ou sempre, com `force`, depois de um 401).
 */
export async function authHeaders({ force = false } = {}) {
    let current = credential;
    if (!current) return {};
    if (current.type === 'key') return { 'X-Api-Key': current.value };
    if (force || current.expiresAt - REFRESH_MARGIN_MS <= Date.now()) current = await refreshed(current);
    return current?.type === 'cognito' ? { Authorization: `Bearer ${current.accessToken}` } : {};
}
