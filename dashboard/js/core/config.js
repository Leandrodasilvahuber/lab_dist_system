// API: o próprio local-server (padrão) ou outra via ?api=https://.../dev
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

export const API_BASE = normalize(params.get('api') ||
    (location.protocol.startsWith('http') ? location.origin : 'http://localhost:3001'));
