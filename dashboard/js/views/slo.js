import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml, ms, time } from '../core/format.js';
import { dataTable } from '../components/data-table.js';
import { errorState } from '../components/empty.js';
import { bindRefresh, hint, panel, PERIODS, refreshButton, select, spacer, status, toolbar } from '../components/layout.js';
import { statCards } from '../components/stat-card.js';

const SLO_ICONS = { 'purchase-latency': 'clock', 'saga-outcome': 'workflow', 'dlq-age': 'inbox' };

export default {
    id: 'slo',
    label: 'SLOs',
    icon: 'target',
    template: () => `
        ${toolbar(select('sloHours', 'Janela', PERIODS.short, '24'), spacer, status('sloUpdated'), refreshButton('sloRefresh'))}
        ${hint(`Critério de sucesso dos testes de carga e caos. Latência e desfecho vêm da tabela de sagas: compra completa vai da
            criação da saga até ela ser marcada COMPLETED, e compensação conta como desfecho aceito (só FAILED e COMPENSATION_FAILED
            violam). A DLQ conta mensagens ainda na fila há mais de 24 h (reprocessar ou descartar = tratar). Na AWS os mesmos SLOs
            existem no CloudWatch Application Signals, com histórico e error budget.`)}
        <div class="stat-grid" id="sloCards"></div>
        ${panel({ title: 'Detalhes', icon: 'list', bodyId: 'sloDetails', flush: true })}`,

    mount() {
        bindRefresh($('sloRefresh'), fetchSlo);
        $('sloHours').addEventListener('change', fetchSlo);
    },

    refresh: fetchSlo
};

// Valor e meta formatados conforme a unidade do SLO (GET /metrics/slo)
function sloValue(slo, value) {
    if (value === null || value === undefined) return '—';
    if (slo.unit === 'ms') return ms(value);
    if (slo.unit === 'ratio') return `${(value * 100).toFixed(2).replace(/\.?0+$/, '').replace('.', ',')}%`;
    return String(value);
}

function sloTarget(slo) {
    if (slo.unit === 'ms') return `meta: < ${ms(slo.target)}`;
    if (slo.unit === 'ratio') return `meta: ≥ ${sloValue(slo, slo.target)}`;
    return `meta: ${slo.target}`;
}

function sloSample(slo) {
    if (slo.id === 'purchase-latency') return `${slo.sample} compras concluídas`;
    if (slo.id === 'saga-outcome') return `${slo.sample} sagas finalizadas`;
    return `${slo.detail.total} na fila` + (slo.detail.partial ? ` (${slo.detail.inspected} inspecionadas)` : '');
}

function sloDuration(value) {
    if (value === null || value === undefined) return '—';
    const hours = value / 3600000;
    return hours >= 1 ? `${hours.toFixed(1).replace('.', ',')} h` : ms(value);
}

async function fetchSlo() {
    const hours = $('sloHours').value;
    const cardsEl = $('sloCards');
    const detailsEl = $('sloDetails');
    let data;
    try {
        data = await api(`/metrics/slo?hours=${hours}`);
    } catch (error) {
        cardsEl.innerHTML = '';
        detailsEl.innerHTML = errorState('Não foi possível avaliar os SLOs', error);
        $('sloUpdated').textContent = '';
        return;
    }
    const { slos } = data;
    $('sloUpdated').textContent = `às ${time(data.generatedAt)}`;

    cardsEl.innerHTML = statCards(slos.map(slo => ({
        label: slo.label,
        icon: SLO_ICONS[slo.id] || 'target',
        value: slo.ok === null ? 'sem dados' : sloValue(slo, slo.value),
        ok: slo.ok,
        detail: `${sloTarget(slo)} · ${sloSample(slo)}`
    })));

    const [latency, outcome, dlq] = ['purchase-latency', 'saga-outcome', 'dlq-age'].map(id => slos.find(slo => slo.id === id));
    const rows = [
        ['Latência p50 / p95 / p99', [latency.detail.p50, latency.detail.p95, latency.detail.p99].map(ms).join(' / ')],
        ['Compra mais lenta', ms(latency.detail.max)],
        ['Concluídas (COMPLETED)', outcome.detail.byStatus.COMPLETED],
        ['Compensadas (COMPENSATED)', outcome.detail.byStatus.COMPENSATED],
        ['Falharam (FAILED)', outcome.detail.byStatus.FAILED],
        ['Compensação falhou (COMPENSATION_FAILED)', outcome.detail.byStatus.COMPENSATION_FAILED],
        ['Em andamento', outcome.detail.inProgress],
        ['Travadas (em andamento há mais de 5 min)', outcome.detail.stuck],
        [`Mensagens na DLQ (${dlq.detail.queue || '—'})`, dlq.detail.total],
        ['Mensagem mais antiga na DLQ', sloDuration(dlq.detail.oldestAgeMs)]
    ];
    detailsEl.innerHTML = dataTable(null, rows.map(([label, value]) => `
        <tr><td class="row-label">${escapeHtml(label)}</td><td class="num">${escapeHtml(value)}</td></tr>`));
}
