// Formatação compartilhada pelas telas. Todo texto vindo da API passa por escapeHtml
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

export function money(value) {
    return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function time(iso) {
    return iso ? new Date(iso).toLocaleTimeString('pt-BR') : '';
}

export function dateTime(iso) {
    return iso ? new Date(iso).toLocaleString('pt-BR') : '—';
}

export const nowTime = () => time(new Date().toISOString());

export function ms(value) {
    if (value === null || value === undefined) return '—';
    return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

export function percent(part, total) {
    return total ? `${Math.round(part / total * 100)}%` : '—';
}
