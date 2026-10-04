import { escapeHtml } from '../core/format.js';
import { icon } from './icons.js';

export function emptyState(message, { icon: name = 'inbox', tone } = {}) {
    return `<div class="empty${tone ? ` empty-${tone}` : ''}">${icon(name, { size: 24 })}<p>${escapeHtml(message)}</p></div>`;
}

export function errorState(prefix, error) {
    return emptyState(`${prefix}: ${error.message}`, { icon: 'alert', tone: 'bad' });
}

// "Tudo certo": lista vazia que é boa notícia (sem erros, DLQ vazia)
export function allClear(message) {
    return emptyState(message, { icon: 'check', tone: 'ok' });
}

export function loading(message = 'Carregando...') {
    return `<div class="empty"><span class="spinner"></span><p>${escapeHtml(message)}</p></div>`;
}
