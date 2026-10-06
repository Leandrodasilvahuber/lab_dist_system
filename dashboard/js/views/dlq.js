import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { dateTime, escapeHtml, nowTime } from '../core/format.js';
import { dataTable, expandableRows } from '../components/data-table.js';
import { allClear, errorState } from '../components/empty.js';
import { icon } from '../components/icons.js';
import { bindRefresh, panel, refreshButton, spacer, status, toolbar } from '../components/layout.js';
import { showToast } from '../components/toast.js';

let dlqMessages = [];

const DLQ_ACTIONS = {
    redrive: { confirm: 'Reprocessar este evento? Ele será republicado e o Stock tentará de novo.', done: 'Evento reprocessado' },
    discard: { confirm: 'Descartar este evento? Ele será apagado da DLQ e não poderá ser recuperado.', done: 'Evento descartado' }
};

export default {
    id: 'dlq',
    label: 'DLQ',
    icon: 'inbox',
    template: () => `
        ${toolbar(status('dlqSummary'), spacer, refreshButton('dlqRefresh'))}
        ${panel({ title: 'DLQ dos eventos de produto', icon: 'inbox', bodyId: 'dlqTable', flush: true })}`,

    mount() {
        $('dlqSummary').textContent = 'Carregando...';
        bindRefresh($('dlqRefresh'), fetchDlq);
        $('dlqTable').addEventListener('click', runAction);
        expandableRows($('dlqTable'), () => dlqMessages);
    },

    refresh: fetchDlq
};

async function fetchDlq() {
    const container = $('dlqTable');
    const summary = $('dlqSummary');
    let result;
    try {
        result = await api('/dlq');
    } catch (error) {
        summary.textContent = '';
        container.innerHTML = errorState('Não foi possível ler a DLQ', error);
        return;
    }
    dlqMessages = result.messages || [];
    summary.textContent = `${result.approximateTotal} mensagem(ns) na ${result.queue} · às ${nowTime()}`;
    if (!dlqMessages.length) {
        container.innerHTML = allClear('DLQ vazia');
        return;
    }
    container.innerHTML = dataTable(['Enviado em', 'Evento', 'Produto', { label: 'Erro', style: 'min-width:240px' }, { label: 'Tentativas', className: 'num' }, 'Ações'], dlqMessages.map((m, index) => `
        <tr class="row-expandable level-error" data-index="${index}">
            <td class="nowrap">${dateTime(m.sentAt)}</td>
            <td><strong>${escapeHtml(m.detailType || 'mensagem inválida')}</strong></td>
            <td><span class="mono">${escapeHtml(m.detail?.productId || '—')}</span>${m.detail?.name ? `<div class="muted">${escapeHtml(m.detail.name)}</div>` : ''}</td>
            <td class="muted">${escapeHtml(m.errorMessage || m.errorCode || '—')}</td>
            <td class="num">${escapeHtml(m.attempts ?? '—')}</td>
            <td>${actionButtons(m)}</td>
        </tr>`));
}

function actionButtons(m) {
    return `
                <div class="actions-cell">
                    <button type="button" class="btn btn-success btn-sm" data-action="redrive" data-id="${escapeHtml(m.messageId)}" ${m.detailType ? '' : 'disabled'}>${icon('undo', { size: 14 })}<span>Reprocessar</span></button>
                    <button type="button" class="btn btn-danger btn-sm" data-action="discard" data-id="${escapeHtml(m.messageId)}">${icon('trash', { size: 14 })}<span>Descartar</span></button>
                </div>`;
}

async function runAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, id } = button.dataset;
    if (!confirm(DLQ_ACTIONS[action].confirm)) return;
    button.disabled = true;
    try {
        await api(`/dlq/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
        showToast(DLQ_ACTIONS[action].done, 'success');
    } catch (error) {
        showToast(`Falhou: ${error.message}`, 'error');
    }
    return fetchDlq();
}
