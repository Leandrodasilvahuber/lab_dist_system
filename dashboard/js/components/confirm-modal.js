import { escapeHtml } from '../core/format.js';
import { icon } from './icons.js';

// Confirmação no visual do dashboard, no lugar do confirm() do navegador.
// Esc, clique no fundo e Cancelar respondem false
let dialog = null;
let settle = null;

function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'modal modal-narrow';
    dialog.setAttribute('aria-labelledby', 'confirmModalTitle');
    dialog.setAttribute('aria-describedby', 'confirmModalText');
    dialog.innerHTML = `
        <div class="alert-modal">
            <span class="alert-modal-icon" id="confirmModalIcon"></span>
            <div class="alert-modal-text">
                <h2 id="confirmModalTitle"></h2>
                <p id="confirmModalText"></p>
            </div>
        </div>
        <div class="modal-actions">
            <button type="button" class="btn btn-secondary" data-answer="no">Cancelar</button>
            <button type="button" class="btn" data-answer="yes"></button>
        </div>`;
    dialog.addEventListener('click', event => {
        const answer = event.target.closest('[data-answer]')?.dataset.answer;
        if (answer) dialog.close(answer);
        else if (event.target === dialog) dialog.close('no');
    });
    dialog.addEventListener('close', () => {
        settle?.(dialog.returnValue === 'yes');
        settle = null;
    });
    document.body.append(dialog);
    return dialog;
}

/**
 * Pergunta e devolve uma Promise<boolean>.
 * danger: ação destrutiva (botão vermelho, foco em Cancelar).
 */
export function confirmDialog({ title, message, confirmLabel = 'Confirmar', danger = false, iconName }) {
    const modal = ensureDialog();
    settle?.(false);
    modal.className = `modal modal-narrow ${danger ? 'tone-bad' : 'tone-brand'}`;
    modal.returnValue = '';
    modal.querySelector('#confirmModalIcon').innerHTML = icon(iconName || (danger ? 'alert' : 'info'), { size: 20 });
    modal.querySelector('#confirmModalTitle').textContent = title;
    modal.querySelector('#confirmModalText').innerHTML = escapeHtml(message).replace(/\n/g, '<br>');
    const yes = modal.querySelector('[data-answer="yes"]');
    yes.className = `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`;
    yes.textContent = confirmLabel;
    modal.showModal();
    modal.querySelector(danger ? '[data-answer="no"]' : '[data-answer="yes"]').focus();
    return new Promise(resolve => { settle = resolve; });
}
