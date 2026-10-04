import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { dateTime, escapeHtml, nowTime } from '../core/format.js';
import { LOG_LEVELS, statusBadge } from '../components/badge.js';
import { dataTable, expandableRows } from '../components/data-table.js';
import { allClear, errorState } from '../components/empty.js';
import { bindRefresh, hint, panel, PERIODS, refreshButton, select, spacer, status, toolbar } from '../components/layout.js';
import { traceButton } from '../components/saga-card.js';

let logEntries = [];

export default {
    id: 'logs',
    label: 'Logs',
    icon: 'file',
    template: () => `
        ${toolbar(
            select('logLevel', 'Nível', [['warn', 'warn + error'], ['error', 'só error (não tratados)']], 'warn'),
            select('logHours', 'Período', PERIODS.short, '24'),
            spacer, status('logsUpdated'), refreshButton('logsRefresh')
        )}
        ${hint(`<strong>warn</strong> = erro tratado (validação/regra de negócio) · <strong>error</strong> = não tratado (conta no alarme).
            Clique numa linha para ver o JSON completo e na lupa para seguir a compra inteira.`)}
        ${panel({ title: 'Logs de erro', icon: 'file', bodyId: 'logsTable', flush: true })}`,

    mount() {
        bindRefresh($('logsRefresh'), fetchLogs);
        $('logLevel').addEventListener('change', fetchLogs);
        $('logHours').addEventListener('change', fetchLogs);
        expandableRows($('logsTable'), () => logEntries);
    },

    refresh: fetchLogs
};

async function fetchLogs() {
    const container = $('logsTable');
    const level = $('logLevel').value;
    const hours = $('logHours').value;
    try {
        logEntries = (await api(`/logs?level=${level}&hours=${hours}`)).logs || [];
    } catch (error) {
        container.innerHTML = errorState('Não foi possível ler os logs', error);
        return;
    }
    $('logsUpdated').textContent = `${logEntries.length} linhas · às ${nowTime()}`;
    if (!logEntries.length) {
        container.innerHTML = allClear('Nenhum erro no período');
        return;
    }
    container.innerHTML = dataTable(['Hora', 'Nível', 'Evento', 'Mensagem', 'Tipo', 'Serviço', ''], logEntries.map((entry, index) => `
        <tr class="row-expandable level-${escapeHtml(entry.status)}" data-index="${index}">
            <td class="nowrap" title="${escapeHtml(entry.timestamp)}">${dateTime(entry.timestamp)}</td>
            <td>${statusBadge(LOG_LEVELS, entry.status)}</td>
            <td><strong>${escapeHtml(entry.event)}</strong></td>
            <td class="muted">${escapeHtml(entry.message || entry.error || '')}</td>
            <td>${escapeHtml(entry.errorType || '—')}</td>
            <td class="nowrap">${escapeHtml(entry.service || '—')}</td>
            <td>${traceButton(entry.correlationId)}</td>
        </tr>`));
}
