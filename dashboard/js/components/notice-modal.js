import { icon } from './icons.js';

let dialog = null;

function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'modal modal-wide';
    dialog.setAttribute('aria-labelledby', 'noticeModalTitle');
    dialog.innerHTML = `
        <header class="modal-head">
            <div class="modal-title">
                <h2 id="noticeModalTitle"></h2>
            </div>
        </header>
        <div class="modal-body reliability-body">
            <div id="noticeModalBody"></div>
            <div class="reliability-actions">
                <button type="button" class="btn btn-primary" data-close>Entendi, fechar</button>
            </div>
        </div>`;
    // Obriga a fechar: só o botão fecha. Clique no fundo e Esc são bloqueados
    dialog.addEventListener('cancel', event => event.preventDefault());
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    document.body.append(dialog);
    return dialog;
}

/**
 * Aviso bloqueante com título e texto (HTML já escapado pelo chamador).
 * Só fecha pelo botão.
 */
export function showNoticeModal({ title, html, iconName = 'lock' }) {
    const modal = ensureDialog();
    modal.querySelector('#noticeModalTitle').innerHTML = `${icon(iconName, { size: 18 })}<span>${title}</span>`;
    modal.querySelector('#noticeModalBody').innerHTML = html;
    if (!modal.open) modal.showModal();
}
