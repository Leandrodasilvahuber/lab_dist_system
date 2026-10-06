// Formatação compartilhada pelas telas. Todo texto vindo da API passa por escapeHtml
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

export function money(value) {
    return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Custos de laboratório ficam em frações de centavo: abaixo de US$ 0,01,
// dois dígitos significativos (US$ 0,000026) em vez de arredondar para zero
export function usd(value) {
    if (value === null || value === undefined) return '—';
    const options = value !== 0 && Math.abs(value) < 0.01
        ? { maximumSignificantDigits: 2 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'USD', ...options });
}

export function time(iso) {
    return iso ? new Date(iso).toLocaleTimeString('pt-BR') : '';
}

export function dateTime(iso) {
    return iso ? new Date(iso).toLocaleString('pt-BR') : '—';
}

export const nowTime = () => time(new Date().toISOString());

// 12:00 (hora local de quem vê): quando um limite diário zera
export function hourMinute(iso) {
    return iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
}

export function ms(value) {
    if (value === null || value === undefined) return '—';
    return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

export function percent(part, total) {
    return total ? `${Math.round(part / total * 100)}%` : '—';
}
