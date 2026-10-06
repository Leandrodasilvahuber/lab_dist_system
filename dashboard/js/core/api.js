import { API_BASE } from './config.js';
import { emit } from './events.js';
import { authHeaders, getCredential, setCredential } from './session.js';

export const isAuthError = error => error.status === 401 || error.status === 403;

async function request(path, options, force) {
    return fetch(API_BASE + path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(await authHeaders({ force })),
            ...(options.headers || {})
        }
    });
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
