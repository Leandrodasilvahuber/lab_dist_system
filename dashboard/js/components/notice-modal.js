import { escapeHtml } from '../core/format.js';
import { icon } from './icons.js';

let dialog = null;

function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'modal modal-narrow';
    dialog.setAttribute('aria-labelledby', 'noticeModalTitle');
    dialog.innerHTML = `
        <div class="alert-modal">
            <span class="alert-modal-icon" id="noticeModalIcon"></span>
            <div class="alert-modal-text">
                <h2 id="noticeModalTitle"></h2>
                <div id="noticeModalBody"></div>
            </div>
        </div>
        <div class="modal-actions">
            <button type="button" class="btn btn-primary" data-close>Entendi, fechar</button>
        </div>`;
    // Obriga a fechar: só o botão fecha. Clique no fundo e Esc são bloqueados
    dialog.addEventListener('cancel', event => event.preventDefault());
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    document.body.append(dialog);
    return dialog;
}

/**
 * Aviso bloqueante com título e texto. Só fecha pelo botão.
 * html: já escapado pelo chamador; text: texto puro (escapado aqui).
 * tone: info | warn | bad (cor do ícone)
 */
export function showNoticeModal({ title, html, text, iconName = 'lock', tone = 'info' }) {
    const modal = ensureDialog();
    modal.className = `modal modal-narrow tone-${tone}`;
    modal.querySelector('#noticeModalIcon').innerHTML = icon(iconName, { size: 20 });
    modal.querySelector('#noticeModalTitle').textContent = title;
    modal.querySelector('#noticeModalBody').innerHTML = html ?? `<p>${escapeHtml(text)}</p>`;
    if (!modal.open) modal.showModal();
}
