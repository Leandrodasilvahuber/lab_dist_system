import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml, ms, nowTime, time } from '../core/format.js';
import { SAGA_STATUS, statusBadge } from '../components/badge.js';
import { dataTable } from '../components/data-table.js';
import { emptyState, errorState } from '../components/empty.js';
import { bindRefresh, panel, refreshButton, spacer, status, toolbar } from '../components/layout.js';
import { statCards } from '../components/stat-card.js';

const LEGEND = `
    <div class="legend">
        <span><i class="ok"></i>passo ok</span>
        <span><i class="failed"></i>passo falhou</span>
        <span><i class="compensation"></i>compensação</span>
        <span><i class="skipped"></i>nada a desfazer</span>
        <span><i class="running"></i>em andamento</span>
    </div>`;

// Tempos do histórico do Step Functions. A tela Comprar mede pelos registros
// da tabela de sagas (da criação da saga até cada passo gravado), então os
// números das duas não batem: os títulos dizem o critério de cada uma
const STEP_TIME = 'Tempo dentro do estado da Lambda no Step Functions, com as tentativas (sem o registro do passo na tabela de sagas)';
const TOTAL_TIME = 'Do início ao fim da execução no Step Functions (inclui os registros na tabela de sagas)';

export default {
    id: 'performance',
    label: 'Desempenho',
    icon: 'gauge',
    template: () => `
        ${toolbar(status('perfUpdated'), spacer, refreshButton('perfRefresh'))}
        <div class="stat-grid" id="perfSummary"></div>
        ${panel({ title: 'Por passo', icon: 'list', bodyId: 'perfSteps', flush: true })}
        ${panel({ title: 'Linha do tempo das compras', icon: 'clock', actions: LEGEND, bodyId: 'perfSagas', flush: true })}`,

    mount() {
        $('perfUpdated').textContent = 'Carregando...';
        bindRefresh($('perfRefresh'), fetchPerformance);
    },

    refresh: fetchPerformance
};

function timelineBars(saga) {
    const start = Date.parse(saga.startedAt);
    const total = saga.durationMs ?? Math.max(Date.now() - start, 1);
    return saga.steps.map(step => {
        const offset = Math.max(Date.parse(step.startedAt) - start, 0);
        const width = step.durationMs ?? Math.max(start + total - Date.parse(step.startedAt), 0);
        const kind = step.ok === null ? 'running' : step.ok === false ? 'failed'
            : step.skipped ? 'skipped' : step.compensation ? 'compensation' : '';
        const title = `${step.name}: ${ms(step.durationMs)}` +
            (step.skipped ? ' · nada a desfazer' : '') +
            (step.attempts > 1 ? ` · ${step.attempts} tentativas` : '') +
            (step.error ? ` · ${step.error}` : '');
        return `<div class="bar ${kind}" title="${escapeHtml(title)}"
            style="left:${(offset / total * 100).toFixed(2)}%;width:${(width / total * 100).toFixed(2)}%"></div>`;
    }).join('');
}

async function fetchPerformance() {
    const summaryEl = $('perfSummary');
    const stepsEl = $('perfSteps');
    const sagasEl = $('perfSagas');
    let data;
    try {
        data = await api('/metrics/sagas');
    } catch (error) {
        summaryEl.innerHTML = '';
        stepsEl.innerHTML = errorState('Não foi possível ler as métricas', error);
        sagasEl.innerHTML = '';
        $('perfUpdated').textContent = '';
        return;
    }
    const { summary, steps, sagas } = data;
    $('perfUpdated').textContent = `${summary.total} compras · às ${nowTime()}`;

    summaryEl.innerHTML = statCards([
        { label: 'Compras analisadas', value: summary.total, icon: 'cart', tone: 'brand' },
        { label: 'Concluídas', value: summary.completed, icon: 'check', tone: 'ok', ok: true },
        // Mesmos nomes de GET /saga/{id}: desfeita (compensada) não é falha
        { label: 'Desfeitas', value: summary.compensated, icon: 'undo', tone: 'warn', detail: 'compensadas' },
        { label: 'Falharam', value: summary.failed, icon: 'alert', tone: 'bad', ok: summary.failed === 0 },
        { label: 'Em andamento', value: summary.running, icon: 'workflow', tone: 'info' },
        { label: 'Tempo médio', value: ms(summary.avgMs), icon: 'clock', tone: 'brand' },
        { label: 'Mais lenta', value: ms(summary.maxMs), icon: 'gauge', tone: 'warn' }
    ]);

    if (!sagas.length) {
        stepsEl.innerHTML = emptyState('Nenhuma compra executada ainda.', { icon: 'cart' });
        sagasEl.innerHTML = '';
        return;
    }

    stepsEl.innerHTML = dataTable(
        ['Passo', ...['Execuções', 'Média', 'Máximo', 'Falhas', 'Retries'].map(label => ({ label, className: 'num', title: STEP_TIME }))],
        steps.map(step => `
            <tr class="${step.failed ? 'row-alert' : ''}">
                <td><strong>${escapeHtml(step.name)}</strong>${step.compensation ? ` <span class="muted">(compensação${step.skipped ? ` · ${step.skipped} sem nada a desfazer` : ''})</span>` : ''}</td>
                <td class="num">${escapeHtml(step.count)}</td>
                <td class="num">${escapeHtml(ms(step.avgMs))}</td>
                <td class="num">${escapeHtml(ms(step.maxMs))}</td>
                <td class="num">${escapeHtml(step.failed)}</td>
                <td class="num">${escapeHtml(step.retries)}</td>
            </tr>`)
    );

    sagasEl.innerHTML = dataTable(
        ['Início', 'Saga', 'Status', { label: 'Duração', className: 'num', title: TOTAL_TIME }, { label: 'Passos', style: 'width:45%' }],
        sagas.map(saga => `
            <tr>
                <td class="nowrap" title="${escapeHtml(saga.startedAt)}">${escapeHtml(time(saga.startedAt))}</td>
                <td class="mono"><span class="clickable" data-trace="${escapeHtml(saga.sagaId)}" title="Rastrear ${escapeHtml(saga.sagaId)}">${escapeHtml(saga.sagaId)}</span></td>
                <td>${statusBadge(SAGA_STATUS, saga.status, { pulse: ['RUNNING', 'COMPENSATING'].includes(saga.status) })}</td>
                <td class="num nowrap">${escapeHtml(ms(saga.durationMs))}</td>
                <td><div class="timeline">${timelineBars(saga)}</div></td>
            </tr>`)
    );
}
