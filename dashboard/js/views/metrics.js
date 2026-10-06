import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml, ms, nowTime, percent } from '../core/format.js';
import { periodLabel, stackedChart } from '../components/chart.js';
import { dataTable } from '../components/data-table.js';
import { emptyState, errorState } from '../components/empty.js';
import { bindRefresh, panel, PERIODS, refreshButton, select, spacer, status, toolbar } from '../components/layout.js';
import { statCards } from '../components/stat-card.js';

export default {
    id: 'metrics',
    label: 'Métricas',
    icon: 'chart',
    // GET /metrics/errors é de admin (GetMetricData é cobrado por métrica)
    requiresAdmin: true,
    template: () => `
        ${toolbar(select('metricsHours', 'Período', PERIODS.metrics, '24'), spacer, status('metricsUpdated'), refreshButton('metricsRefresh'))}
        <div class="stat-grid" id="metricsSummary"></div>
        ${panel({ title: 'Erros de negócio por tipo', icon: 'alert', bodyId: 'businessChart' })}
        ${panel({ title: 'Erros não tratados por tipo', icon: 'alert', bodyId: 'unhandledChart' })}
        ${panel({ title: 'Ações da saga e dos eventos', icon: 'workflow', bodyId: 'metricsActions', flush: true })}`,

    mount() {
        bindRefresh($('metricsRefresh'), fetchMetrics);
        $('metricsHours').addEventListener('change', fetchMetrics);
    },

    refresh: fetchMetrics
};

async function fetchMetrics() {
    const hours = $('metricsHours').value;
    const summaryEl = $('metricsSummary');
    const charts = ['businessChart', 'unhandledChart', 'metricsActions'].map($);
    $('metricsUpdated').textContent = 'Carregando...';
    let data;
    try {
        data = await api(`/metrics/errors?hours=${hours}`);
    } catch (error) {
        summaryEl.innerHTML = '';
        charts.forEach(el => { el.innerHTML = ''; });
        charts[0].innerHTML = errorState('Não foi possível ler as métricas', error);
        $('metricsUpdated').textContent = '';
        return;
    }
    const { buckets, periodSeconds, business, unhandled, actions } = data;
    const calls = actions.reduce((sum, a) => sum + a.calls, 0);
    const durationSum = actions.reduce((sum, a) => sum + (a.avgMs || 0) * a.calls, 0);
    summaryEl.innerHTML = statCards([
        { label: 'Erros de negócio', value: business.total, icon: 'alert', tone: 'warn', detail: business.byType[0] ? `mais comum: ${business.byType[0].errorType}` : 'nenhum' },
        { label: 'Erros não tratados', value: unhandled.total, icon: 'alert', tone: 'bad', ok: unhandled.total === 0, detail: unhandled.byType[0] ? `mais comum: ${unhandled.byType[0].errorType}` : 'nenhum' },
        // Leituras de algo que não existe (GET com 404): fora do alarme de erros de negócio
        { label: 'Leituras não encontradas (404)', value: data.client?.total ?? 0, icon: 'search', tone: 'info', detail: 'fora dos alarmes · cliente com bug ou id antigo' },
        { label: 'Ações executadas', value: calls, icon: 'workflow', tone: 'info', detail: `${actions.length} tipos de ação` },
        { label: 'Duração média por ação', value: calls ? ms(Math.round(durationSum / calls)) : '—', icon: 'clock', tone: 'brand', detail: 'ponderada pelas chamadas' }
    ]);

    const typeSeries = group => group.byType.map(t => ({ label: t.errorType, values: t.values, total: t.total }));
    charts[0].innerHTML = stackedChart(buckets, periodSeconds, typeSeries(business));
    charts[1].innerHTML = stackedChart(buckets, periodSeconds, typeSeries(unhandled));

    charts[2].innerHTML = actions.length ? dataTable(
        ['Ação', ...['Chamadas', 'OK', 'Rejeitadas (negócio)', 'Falhas (infra)', 'Média', 'Máximo'].map(label => ({ label, className: 'num' }))],
        actions.map(a => `
            <tr class="${a.failed ? 'row-alert' : ''}">
                <td><strong>${escapeHtml(a.action)}</strong></td>
                <td class="num">${escapeHtml(a.calls)}</td>
                <td class="num">${escapeHtml(a.ok)}</td>
                <td class="num">${escapeHtml(a.rejected)} <span class="muted">(${percent(a.rejected, a.calls)})</span></td>
                <td class="num ${a.failed ? 'rate-bad' : ''}">${escapeHtml(a.failed)} <span class="muted">(${percent(a.failed, a.calls)})</span></td>
                <td class="num">${escapeHtml(ms(a.avgMs))}</td>
                <td class="num">${escapeHtml(ms(a.maxMs))}</td>
            </tr>`)
    ) : emptyState('Nenhuma ação executada no período.', { icon: 'workflow' });
    $('metricsUpdated').textContent = `por ${periodLabel(periodSeconds)} · às ${nowTime()}`;
}
