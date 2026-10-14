import { escapeHtml } from '../core/format.js';
import { icon } from './icons.js';

const ICONS = { success: 'check', error: 'alert', info: 'info' };
// Erro costuma ter texto longo e pedir ação: fica mais tempo na tela
const DURATION = { error: 8000 };
let timer;

export function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.className = `toast toast-${type}`;
    // Erro interrompe o leitor de tela; o resto espera a vez
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.innerHTML = `<span class="toast-icon">${icon(ICONS[type] || 'info', { size: 16 })}</span>
        <span class="toast-text">${escapeHtml(message)}</span>
        <button type="button" class="toast-close" aria-label="Fechar aviso">${icon('x', { size: 14 })}</button>`;
    toast.querySelector('.toast-close').addEventListener('click', () => { toast.hidden = true; });
    toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => { toast.hidden = true; }, DURATION[type] || 4000);
}
