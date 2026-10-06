import { API_BASE } from './config.js';
import { getAdminKey } from './session.js';

export const isAuthError = error => error.status === 401 || error.status === 403;

export async function api(path, options = {}) {
    const adminKey = getAdminKey();
    const response = await fetch(API_BASE + path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(adminKey && { 'X-Api-Key': adminKey }),
            ...(options.headers || {})
        }
    });
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
