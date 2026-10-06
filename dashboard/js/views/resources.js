import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml, hourMinute, nowTime, usd } from '../core/format.js';
import { lineChart, periodLabel, stackedChart } from '../components/chart.js';
import { dataTable } from '../components/data-table.js';
import { emptyState, errorState } from '../components/empty.js';
import { icon } from '../components/icons.js';
import { bindRefresh, panel, PERIODS, refreshButton, select, spacer, status, toolbar } from '../components/layout.js';
import { statCards } from '../components/stat-card.js';
import { showToast } from '../components/toast.js';

const COST_DAYS = [['7', 'últimos 7 dias'], ['14', 'últimos 14 dias'], ['30', 'últimos 30 dias'], ['90', 'últimos 90 dias']];
// O Cost Explorer lista todos os serviços da conta: o resto vira "Outros"
const MAX_COST_SERIES = 6;

export default {
    id: 'resources',
    label: 'Recursos',
    icon: 'cpu',
    // Memória (GetMetricData) e custo da conta (Cost Explorer) são de admin
    requiresAdmin: true,
    template: () => `
        ${toolbar(
            select('memoryHours', 'Memória', PERIODS.metrics, '3'),
            select('costDays', 'Custo', COST_DAYS, '14'),
            spacer, status('resourcesUpdated'), refreshButton('resourcesRefresh'))}
        <div class="stat-grid" id="memoryCards"></div>
        ${panel({ title: 'Memória usada por função (máximo por balde)', icon: 'cpu', bodyId: 'memoryChart' })}
        <div class="stat-grid" id="costCards"></div>
        ${panel({ title: 'Custo estimado por dia', icon: 'dollar', bodyId: 'costEstimatedChart' })}
        ${panel({
            title: 'Custo real por dia (Cost Explorer)',
            icon: 'dollar',
            bodyId: 'costActualChart',
            actions: `<button type="button" class="btn btn-secondary btn-sm" id="costRefreshNow">${icon('refresh', { size: 15 })}<span>Atualizar agora</span></button>`
        })}
        ${panel({ title: 'Estimado × real por serviço', icon: 'list', bodyId: 'costTable', flush: true })}`,

    mount() {
        bindRefresh($('resourcesRefresh'), fetchResources);
        $('memoryHours').addEventListener('change', fetchMemory);
        $('costDays').addEventListener('change', fetchCost);
        bindRefresh($('costRefreshNow'), refreshCostNow);
    },

    refresh: fetchResources
};

async function fetchResources() {
    $('resourcesUpdated').textContent = 'Carregando...';
    await Promise.all([fetchMemory(), fetchCost()]);
    $('resourcesUpdated').textContent = `às ${nowTime()}`;
}

// distributed-ecommerce-system-OrderFunction-AbC123 → OrderFunction
const shortName = name => name.match(/([A-Z][A-Za-z]*Function)/)?.[1] || name;
const mb = value => value === null || value === undefined ? '—' : `${Math.round(value)} MB`;

async function fetchMemory() {
    const cards = $('memoryCards');
    const chart = $('memoryChart');
    let data;
    try {
        data = await api(`/metrics/memory?hours=${$('memoryHours').value}`);
    } catch (error) {
        cards.innerHTML = '';
        chart.innerHTML = errorState('Não foi possível ler a memória', error);
        return;
    }
    const { buckets, periodSeconds, functions } = data;
    if (!functions.length) {
        cards.innerHTML = '';
        chart.innerHTML = emptyState('Nenhuma invocação no período.', { icon: 'cpu' });
        return;
    }
    cards.innerHTML = statCards(functions.map(f => {
        const ratio = f.limitMb ? f.peak / f.limitMb : null;
        return {
            label: shortName(f.name),
            value: mb(f.peak),
            icon: 'cpu',
            tone: ratio === null ? 'info' : ratio >= 0.95 ? 'bad' : ratio >= 0.8 ? 'warn' : 'ok',
            ok: ratio === null ? null : ratio < 0.8,
            detail: ratio === null ? 'pico · processo sem limite' : `pico · ${Math.round(ratio * 100)}% de ${f.limitMb} MB`
        };
    }));
    // Limite em comum (o MemorySize do template): uma linha de referência só
    const limits = [...new Set(functions.map(f => f.limitMb).filter(Boolean))];
    chart.innerHTML = lineChart(
        buckets,
        periodSeconds,
        functions.map(f => ({ label: shortName(f.name), values: f.max, total: f.peak })),
        { refLines: limits.map(value => ({ value, label: 'MemorySize' })), format: mb }
    );
}

// Os maiores serviços e o resto somado em "Outros"
function topSeries(byService) {
    const top = byService.slice(0, MAX_COST_SERIES).map(s => ({ label: s.service, values: s.values, total: s.total }));
    const rest = byService.slice(MAX_COST_SERIES);
    if (rest.length) {
        top.push({
            label: `Outros (${rest.length})`,
            values: rest[0].values.map((_, i) => rest.reduce((sum, s) => sum + s.values[i], 0)),
            total: rest.reduce((sum, s) => sum + s.total, 0)
        });
    }
    return top;
}

// "há 2 h": o custo real só muda a cada leitura, a hora exata importa pouco
function ago(iso) {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return 'agora';
    if (minutes < 60) return `há ${minutes} min`;
    return `há ${Math.round(minutes / 60)} h`;
}

async function refreshCostNow() {
    try {
        await api('/metrics/cost/refresh', { method: 'POST' });
        showToast('Custo real lido do Cost Explorer', 'success');
    } catch (error) {
        if (error.body?.code === 'CostRefreshLimitExceeded') {
            alert(`Total de atualizações do dia excedido (${error.body.limit}). O limite zera às ${hourMinute(error.body.resetsAt)}.`);
            return;
        }
        const message = error.status === 429 && error.retryAfter
            ? `Cost Explorer lido há pouco; de novo às ${hourMinute(new Date(Date.now() + error.retryAfter * 1000).toISOString())}`
            : `Falhou: ${error.message}`;
        showToast(message, 'error');
        return;
    }
    await fetchCost();
}

async function fetchCost() {
    const cards = $('costCards');
    const panels = ['costEstimatedChart', 'costActualChart', 'costTable'].map($);
    let data;
    try {
        data = await api(`/metrics/cost?days=${$('costDays').value}`);
    } catch (error) {
        cards.innerHTML = '';
        panels.forEach(el => { el.innerHTML = ''; });
        panels[0].innerHTML = errorState('Não foi possível calcular o custo', error);
        return;
    }
    const { buckets, estimated, estimatedError, actual, actualReason, forecast, budgetUsd, days } = data;
    const period = 86400;
    const budgetRatio = budgetUsd && forecast ? forecast.monthTotal / budgetUsd : null;

    cards.innerHTML = statCards([
        { label: 'Estimado no período', value: estimated ? usd(estimated.total) : '—', icon: 'dollar', tone: 'brand', detail: estimated ? `${days} dias · métricas × preço` : estimatedError },
        {
            label: 'Real no período',
            value: actual ? usd(actual.total) : '—',
            icon: 'receipt',
            tone: 'info',
            detail: actual ? `Cost Explorer · conta inteira · atualizado ${ago(actual.fetchedAt)}` : actualReason
        },
        {
            label: 'Mês até hoje',
            value: actual ? usd(actual.monthToDate) : '—',
            icon: 'clock',
            tone: 'info',
            detail: forecast ? `previsão do mês: ${usd(forecast.monthTotal)}` : 'sem previsão'
        },
        {
            label: 'Budget mensal',
            value: budgetUsd ? usd(budgetUsd) : '—',
            icon: 'bell',
            tone: budgetRatio === null ? 'info' : budgetRatio > 1 ? 'bad' : budgetRatio > 0.8 ? 'warn' : 'ok',
            ok: budgetRatio === null ? null : budgetRatio <= 1,
            detail: budgetRatio !== null ? `previsão em ${Math.round(budgetRatio * 100)}% do teto` : budgetUsd ? 'sem previsão ainda' : 'só na AWS (AWS Budgets)'
        }
    ]);

    panels[0].innerHTML = estimated
        ? stackedChart(buckets, period, topSeries(estimated.byService), { format: usd })
            + (estimated.notes?.length ? `<p class="muted chart-notes">${estimated.notes.map(escapeHtml).join(' · ')}</p>` : '')
        : emptyState(estimatedError || 'Estimativa indisponível', { icon: 'alert', tone: 'bad' });
    panels[1].innerHTML = actual
        ? stackedChart(buckets, period, topSeries(actual.byService), { format: usd })
        : emptyState(actualReason || 'Custo real indisponível', { icon: 'info' });

    // Estimado × real lado a lado (os nomes da estimativa são os SERVICE do Cost Explorer)
    const services = new Map((estimated?.byService || []).map(s => [s.service, { estimated: s.total, actual: null }]));
    for (const s of actual?.byService || []) {
        services.set(s.service, { estimated: services.get(s.service)?.estimated ?? null, actual: s.total });
    }
    const rows = [...services.entries()].sort((a, b) => (b[1].actual ?? b[1].estimated) - (a[1].actual ?? a[1].estimated));
    panels[2].innerHTML = rows.length ? dataTable(
        ['Serviço', ...['Estimado', 'Real'].map(label => ({ label, className: 'num' }))],
        rows.map(([service, v]) => `
            <tr>
                <td><strong>${escapeHtml(service)}</strong></td>
                <td class="num">${v.estimated === null ? '<span class="muted">fora da estimativa</span>' : escapeHtml(usd(v.estimated))}</td>
                <td class="num">${v.actual === null ? '<span class="muted">—</span>' : escapeHtml(usd(v.actual))}</td>
            </tr>`)
    ) : emptyState(`Nenhum custo nos últimos ${days} dias (por ${periodLabel(period)}).`, { icon: 'dollar' });
}
