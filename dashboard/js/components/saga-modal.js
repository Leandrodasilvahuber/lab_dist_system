import { escapeHtml, time } from '../core/format.js';
import { productNames } from '../services/catalog.js';
import { getSaga } from '../services/sagas.js';
import { SAGA_STATUS, statusBadge } from './badge.js';
import { errorState, loading } from './empty.js';
import { icon } from './icons.js';
import { TERMINAL } from './saga-card.js';
import { sagaDiagram } from './saga-flow.js';

// Intervalo da consulta enquanto a saga não termina e a modal está aberta
const POLL_MS = 1000;

let dialog = null;
let pollTimer = null;
// Saga mostrada agora: uma resposta atrasada de outra saga não sobrescreve
let currentId = null;

function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'modal modal-wide';
    dialog.setAttribute('aria-labelledby', 'flowModalTitle');
    dialog.innerHTML = `
        <header class="modal-head">
            <div class="modal-title">
                <h2 id="flowModalTitle"></h2>
                <span class="modal-sub" id="flowModalSub"></span>
            </div>
            <button type="button" class="icon-btn" data-close aria-label="Fechar">${icon('x', { size: 18 })}</button>
        </header>
        <div class="modal-body" id="flowModalBody"></div>`;
    dialog.addEventListener('click', event => {
        // Clique no fundo (fora da caixa) ou no X fecha
        if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
    });
    dialog.addEventListener('close', () => {
        clearTimeout(pollTimer);
        currentId = null;
    });
    document.body.append(dialog);
    return dialog;
}

function render(saga) {
    const names = productNames();
    dialog.querySelector('#flowModalTitle').innerHTML =
        `<span>${escapeHtml(names[saga.productId] || saga.productId)} × ${escapeHtml(saga.quantity)}</span>${statusBadge(SAGA_STATUS, saga.status, { pulse: !TERMINAL.includes(saga.status) })}`;
    dialog.querySelector('#flowModalSub').textContent = `${time(saga.createdAt)} · ${saga.id}`;
    dialog.querySelector('#flowModalBody').innerHTML = sagaDiagram(saga);
}

async function load(id) {
    clearTimeout(pollTimer);
    let saga;
    try {
        saga = await getSaga(id);
    } catch (error) {
        if (currentId === id) dialog.querySelector('#flowModalBody').innerHTML = errorState('Não foi possível carregar a compra', error);
        return;
    }
    if (currentId !== id) return;
    render(saga);
    // Em andamento: segue atualizando enquanto a modal estiver aberta
    if (!TERMINAL.includes(saga.status)) pollTimer = setTimeout(() => load(id), POLL_MS);
}

/** Abre a modal com o diagrama da saga. `saga`: já em mãos, mostra na hora. */
export function openSagaFlow(id, saga = null) {
    ensureDialog();
    currentId = id;
    dialog.querySelector('#flowModalTitle').textContent = 'Fluxo da compra';
    dialog.querySelector('#flowModalSub').textContent = id;
    dialog.querySelector('#flowModalBody').innerHTML = loading();
    if (saga) render(saga);
    if (!dialog.open) dialog.showModal();
    load(id);
}
