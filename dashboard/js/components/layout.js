import { escapeHtml } from '../core/format.js';
import { icon } from './icons.js';

// Cartão com título, ações à direita e corpo. flush: sem margem (tabelas)
export function panel({ title, icon: name, actions = '', body = '', bodyId, flush = false }) {
    return `
        <section class="panel">
            ${title ? `
            <header class="panel-head">
                <h2>${name ? icon(name, { size: 17 }) : ''}<span>${escapeHtml(title)}</span></h2>
                ${actions ? `<div class="panel-actions">${actions}</div>` : ''}
            </header>` : ''}
            <div class="panel-body${flush ? ' flush' : ''}"${bodyId ? ` id="${bodyId}"` : ''}>${body}</div>
        </section>`;
}

export function toolbar(...items) {
    return `<div class="toolbar">${items.join('')}</div>`;
}

export const spacer = '<span class="spacer"></span>';

export const status = id => `<span class="toolbar-status" id="${id}"></span>`;

export function refreshButton(id) {
    return `<button type="button" class="btn btn-secondary btn-sm" id="${id}">${icon('refresh', { size: 15 })}<span>Atualizar</span></button>`;
}

// Atalho para outra tela (o main.js trata todo [data-nav])
export function navLink(view, label, name) {
    return `<button type="button" class="link-btn" data-nav="${view}">${icon(name, { size: 14 })}<span>${escapeHtml(label)}</span></button>`;
}

export const PERIODS = {
    short: [['1', 'última hora'], ['24', 'últimas 24 h'], ['168', 'últimos 7 dias']],
    metrics: [['1', 'última hora'], ['3', 'últimas 3 h'], ['24', 'últimas 24 h'], ['168', 'últimos 7 dias']]
};

export function select(id, label, options, selected) {
    return `
        <label class="select-field"><span>${escapeHtml(label)}</span>
            <select id="${id}">${options.map(([value, text]) =>
                `<option value="${value}"${value === selected ? ' selected' : ''}>${escapeHtml(text)}</option>`).join('')}
            </select>
        </label>`;
}

// Liga o botão Atualizar: gira o ícone enquanto a carga não termina
export function bindRefresh(button, load) {
    button.addEventListener('click', async () => {
        const svg = button.querySelector('.icon');
        svg?.classList.add('spinning');
        button.disabled = true;
        try {
            await load();
        } finally {
            svg?.classList.remove('spinning');
            button.disabled = false;
        }
    });
}
