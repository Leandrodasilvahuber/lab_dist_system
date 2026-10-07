import { DEFAULT_API } from './runtime-config.js';

// API: ?api=https://.../dev, senão a do deploy (runtime-config.js, no CloudFront),
// senão o próprio local-server
const params = new URLSearchParams(location.search);

// Forma canônica (host em minúsculas, sem barra final): o mesmo endereço
// escrito de outro jeito não vira outra API (e outra chave de admin, em session.js).
// Fica só origem + caminho: credenciais (user:pass@), query e #hash no ?api=
// não fazem sentido como base das rotas e são descartados
function normalize(base) {
    try {
        const url = new URL(base);
        return (url.origin + url.pathname).replace(/\/+$/, '');
    } catch {
        return base.replace(/\/+$/, '');
    }
}

export const API_BASE = normalize(params.get('api') || DEFAULT_API ||
    (location.protocol.startsWith('http') ? location.origin : 'http://localhost:3001'));
