import { escapeHtml } from '../core/format.js';
import { icon } from './icons.js';

// ok: true = saudável, false = problema, null = só informativo.
// tone pinta o ícone (ok | warn | bad | info | brand | store); sem tone, a cor do grupo
export function statCard({ label, value, detail, ok = null, icon: name, tone, id }) {
    const state = ok === true ? ' stat-ok' : ok === false ? ' stat-fail' : '';
    return `
        <div class="stat${state}${tone ? ` tone-${tone}` : ''}"${id ? ` id="${escapeHtml(id)}"` : ''}>
            <div class="stat-head">
                <span class="stat-label">${escapeHtml(label)}</span>
                ${name ? `<span class="stat-icon">${icon(name, { size: 16 })}</span>` : ''}
            </div>
            <div class="stat-value">${escapeHtml(value)}</div>
            ${detail ? `<div class="stat-detail">${escapeHtml(detail)}</div>` : ''}
        </div>`;
}

export const statCards = cards => cards.map(statCard).join('');
