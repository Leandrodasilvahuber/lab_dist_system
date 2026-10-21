import { API_BASE } from './config.js';
import { emit } from './events.js';
import { authHeaders, getCredential, setCredential } from './session.js';

export const isAuthError = error => error.status === 401 || error.status === 403;

// Content-Type só com corpo: num GET ele obrigava o navegador a um preflight
// OPTIONS por URL, e o preflight conta no limite da rota no HttpApi. Ao abrir
// a página, os 429 nos preflights viravam "Failed to fetch"
async function send(path, options, force) {
    return fetch(API_BASE + path, {
        ...options,
        headers: {
            ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
            ...(await authHeaders({ force })),
            ...(options.headers || {})
        }
    });
}

// Leitura que falhou na rede (conexão HTTP/2 caída, preflight recusado) é
// repetida; escrita não, porque pode ter chegado ao servidor. Depois de muito
// tempo parada a aba volta com a conexão morta e, ao acordar do sleep, o Wi-Fi
// ainda reconectando: uma tentativa só, 500 ms depois, falhava de novo
const RETRY_DELAYS_MS = [500, 1500, 3000];

// Sem rede (navigator.onLine false): espera o evento 'online' até o tempo da
// tentativa, em vez de gastar a tentativa numa falha certa
function waitForNetwork(ms) {
    return new Promise(resolve => {
        const done = () => {
            clearTimeout(timer);
            globalThis.removeEventListener?.('online', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        if (globalThis.navigator?.onLine === false) globalThis.addEventListener?.('online', done);
    });
}

async function request(path, options, force) {
    const method = (options.method || 'GET').toUpperCase();
    for (let attempt = 0; ; attempt++) {
        try {
            return await send(path, options, force);
        } catch (error) {
            if (method !== 'GET' || !(error instanceof TypeError) || attempt >= RETRY_DELAYS_MS.length) throw error;
            await waitForNetwork(RETRY_DELAYS_MS[attempt]);
        }
    }
}

export async function api(path, options = {}) {
    let response = await request(path, options, false);
    // Token do Cognito recusado (relógio adiantado, expirou no caminho): renova e
    // tenta uma vez. Seguro mesmo em POST: na AWS o 401 vem do authorizer, antes
    // do serviço. Só com Cognito: no local-server o 401 da chave vem do próprio
    // serviço, e repetir não mudaria nada
    if (response.status === 401 && getCredential()?.type === 'cognito') response = await request(path, options, true);
    // Chave de admin recusada (trocada no .env, servidor reiniciado): sai do
    // modo admin em vez de manter o selo "Admin ativo" com uma chave inválida
    if (response.status === 401 && getCredential()?.type === 'key') {
        setCredential(null);
        emit('admin-rejected');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        // 429 sem code: limite por rota do API Gateway (RouteSettings no template.yaml);
        // com code (limite diário de compras), vale a mensagem do corpo
        const message = isAuthError(response)
            ? 'entre como admin (botão no canto superior direito)'
            : response.status === 429 && !body.code
                ? 'muitas requisições no momento, tente de novo em instantes'
                : body.error || body.message || `HTTP ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        error.body = body;
        // 503: segundos até valer a pena repetir (header exposto pelo CORS)
        error.retryAfter = Number(response.headers.get('Retry-After')) || null;
        throw error;
    }
    return body;
}

/**
 * Confere uma chave de admin no local-server (GET /auth/check, sem ler dados).
 * true: aceita; false: recusada (401); null: não deu para conferir (rede).
 */
export async function checkAdminKey(value) {
    try {
        const response = await fetch(`${API_BASE}/auth/check`, { headers: { 'X-Api-Key': value } });
        if (response.status === 401 || response.status === 403) return false;
        return response.ok ? true : null;
    } catch {
        return null;
    }
}

// Listagens paginadas (GET /products, /stock, /orders, /sagas): segue o nextToken até o fim
export async function apiAll(path, key) {
    const items = [];
    let nextToken;
    do {
        const query = nextToken ? `?limit=100&nextToken=${encodeURIComponent(nextToken)}` : '?limit=100';
        const page = await api(path + query);
        items.push(...(page[key] || []));
        nextToken = page.nextToken;
    } while (nextToken);
    return { [key]: items };
}
