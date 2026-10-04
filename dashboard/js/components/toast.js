import { escapeHtml } from '../core/format.js';
import { icon } from './icons.js';

const ICONS = { success: 'check', error: 'alert', info: 'info' };
let timer;

export function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `${icon(ICONS[type] || 'info')}<span>${escapeHtml(message)}</span>`;
    toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => { toast.hidden = true; }, 4000);
}
