import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml, ms, time } from '../core/format.js';
import { navigate } from '../core/nav.js';
import { getAdminKey } from '../core/session.js';
import { productNames } from '../services/catalog.js';
import { getSaga, sagaIdFrom } from '../services/sagas.js';
import { LOG_LEVELS, statusBadge } from '../components/badge.js';
import { dataTable, expandableRows } from '../components/data-table.js';
import { emptyState, errorState, loading } from '../components/empty.js';
import { icon } from '../components/icons.js';
import { panel } from '../components/layout.js';
import { sagaCard } from '../components/saga-card.js';
import { showToast } from '../components/toast.js';

let traceEntries = [];

export default {
    id: 'trace',
    label: 'Rastreio',
    icon: 'search',
    // GET /trace é de admin (linhas internas das Lambdas)
    requiresAdmin: true,
    template: () => `
        <form class="trace-form" id="traceForm">
            <input type="text" id="traceId" class="input input-mono" placeholder="sagaId, orderId ou correlationId" autocomplete="off" spellcheck="false" required aria-label="Id para rastrear">
            <button type="submit" class="btn btn-primary">${icon('search', { size: 16 })}<span>Rastrear</span></button>
        </form>
        <div id="traceSaga"></div>
        ${panel({
            title: 'Linha do tempo',
            icon: 'clock',
            actions: '<span class="muted" id="traceTitle"></span>',
            bodyId: 'traceLogs',
            flush: true,
            body: emptyState('Informe um id ou clique na lupa numa compra, num log ou na aba Desempenho.', { icon: 'search' })
        })}`,

    mount() {
        $('traceForm').addEventListener('submit', event => {
            event.preventDefault();
            fetchTrace();
        });
        expandableRows($('traceLogs'), () => traceEntries);
    },

    refresh: fetchTrace
};

// Lupa em qualquer tela (compras, logs, desempenho) abre o rastreio daquele id
export function openTrace(id) {
    // Sem a chave, avisa e fica na tela atual (o router voltaria para a inicial)
    if (!getAdminKey()) {
        showToast('Rastreio exige a chave de admin (botão no canto superior direito).', 'info');
        return;
    }
    $('traceId').value = id;
    navigate('trace');
}

async function fetchTrace() {
    const input = $('traceId').value.trim();
    const sagaEl = $('traceSaga');
    const logsEl = $('traceLogs');
    if (!input) return;
    logsEl.innerHTML = loading();

    // Com uma saga, o correlationId dela (pode vir do header da compra) junta tudo
    const sagaId = sagaIdFrom(input);
    const saga = sagaId.startsWith('saga_') ? await getSaga(sagaId).catch(() => null) : null;
    const correlationId = saga?.correlationId || input;
    sagaEl.innerHTML = saga ? sagaCard(saga, productNames()) : '';

    try {
        traceEntries = (await api(`/trace/${encodeURIComponent(correlationId)}`)).logs || [];
    } catch (error) {
        logsEl.innerHTML = errorState('Não foi possível ler os logs', error);
        return;
    }
    $('traceTitle').textContent = `${traceEntries.length} linhas · correlationId ${correlationId}`;
    if (!traceEntries.length) {
        logsEl.innerHTML = emptyState(`Nenhuma linha de log com esse correlationId${saga ? '' : ' (confira o id)'}.`, { icon: 'search' });
        return;
    }
    const start = Date.parse(traceEntries[0].timestamp);
    logsEl.innerHTML = dataTable(['Hora', '+ tempo', 'Serviço', 'Nível', 'Evento', 'Mensagem'], traceEntries.map((entry, index) => `
        <tr class="row-expandable level-${escapeHtml(entry.status)}" data-index="${index}">
            <td class="nowrap" title="${escapeHtml(entry.timestamp)}">${escapeHtml(time(entry.timestamp))}</td>
            <td class="mono muted nowrap">+${escapeHtml(ms(Date.parse(entry.timestamp) - start))}</td>
            <td class="nowrap">${escapeHtml(entry.service || 'local-server')}</td>
            <td>${statusBadge(LOG_LEVELS, entry.status)}</td>
            <td><strong>${escapeHtml(entry.event)}</strong></td>
            <td class="muted">${escapeHtml(entry.message || entry.error || '')}${entry.errorType ? ` (${escapeHtml(entry.errorType)})` : ''}</td>
        </tr>`));
}
