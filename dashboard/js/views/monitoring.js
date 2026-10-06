import { api } from '../core/api.js';
import { API_BASE } from '../core/config.js';
import { $ } from '../core/dom.js';
import { emit } from '../core/events.js';
import { escapeHtml, nowTime, time } from '../core/format.js';
import { ALARM_STATES, statusBadge } from '../components/badge.js';
import { dataTable } from '../components/data-table.js';
import { emptyState, errorState } from '../components/empty.js';
import { bindRefresh, navLink, panel, refreshButton, spacer, status, toolbar } from '../components/layout.js';
import { statCards } from '../components/stat-card.js';

let lastHealth = null;
let lastAlarms = null;

// Cada métrica é um item de MONITORS: check() devolve { value, ok, detail? }.
// Para uma métrica nova, basta acrescentar um item (ok: null = só informativo)
const MONITORS = [
    {
        id: 'api',
        label: 'API',
        icon: 'activity',
        async check() {
            const started = performance.now();
            try {
                const body = await api('/health');
                lastHealth = { ok: true, ms: Math.round(performance.now() - started), body };
            } catch (error) {
                lastHealth = { ok: false, error };
            }
            return lastHealth.ok
                ? { value: 'Sistema saudável', ok: true, detail: 'GET /health' }
                : { value: 'API indisponível', ok: false, detail: lastHealth.error.message };
        }
    },
    {
        id: 'latency',
        label: 'Latência do /health',
        icon: 'zap',
        // Usa a medição do monitor "api" (roda antes, na mesma rodada)
        check: () => lastHealth?.ok
            ? { value: `${lastHealth.ms} ms`, ok: lastHealth.ms < 1000 }
            : { value: '—', ok: false, detail: 'sem resposta' }
    },
    {
        id: 'alarms',
        label: 'Alarmes',
        icon: 'bell',
        async check() {
            try {
                lastAlarms = { ok: true, items: (await api('/alarms')).alarms || [] };
            } catch (error) {
                lastAlarms = { ok: false, error };
                return { value: 'indisponível', ok: false, detail: error.message };
            }
            const firing = lastAlarms.items.filter(a => a.state === 'ALARM').length;
            return lastAlarms.items.length
                ? { value: `${firing} em alarme`, ok: firing === 0, detail: `${lastAlarms.items.length} configurados` }
                : { value: 'nenhum', ok: null, detail: 'Nenhum alarme configurado' };
        }
    },
    {
        id: 'business-errors',
        label: 'Erros (última hora)',
        icon: 'alert',
        async check() {
            try {
                const { business, unhandled } = await api('/metrics/errors?hours=1&summary=1');
                return {
                    value: `${business.total} negócio · ${unhandled.total} não tratados`,
                    ok: unhandled.total === 0,
                    detail: business.byType[0] ? `mais comum: ${business.byType[0].errorType}` : 'via EMF · ver aba Métricas'
                };
            } catch (error) {
                return { value: 'indisponível', ok: false, detail: error.message };
            }
        }
    },
    {
        id: 'slo',
        label: 'SLOs (24 h)',
        icon: 'target',
        async check() {
            try {
                const { slos } = await api('/metrics/slo?hours=24');
                const evaluated = slos.filter(slo => slo.ok !== null);
                const violated = slos.filter(slo => slo.ok === false);
                return {
                    value: evaluated.length ? `${evaluated.length - violated.length}/${evaluated.length} OK` : 'sem dados',
                    ok: evaluated.length ? violated.length === 0 : null,
                    detail: violated.length ? `violado: ${violated.map(slo => slo.label).join(', ')}` : 'ver aba SLOs'
                };
            } catch (error) {
                return { value: 'indisponível', ok: false, detail: error.message };
            }
        }
    },
    {
        id: 'endpoint',
        label: 'Endpoint',
        icon: 'link',
        check: () => ({ value: API_BASE.replace(/^https?:\/\//, ''), ok: null, detail: API_BASE })
    }
];

export default {
    id: 'monitoring',
    label: 'Monitoramento',
    icon: 'activity',
    template: () => `
        ${toolbar(status('monitorUpdated'), spacer, refreshButton('monitorRefresh'))}
        <div class="stat-grid" id="monitorGrid"></div>
        ${panel({
            title: 'Alarmes (CloudWatch)',
            icon: 'bell',
            actions: navLink('metrics', 'Métricas', 'chart') + navLink('logs', 'Logs de erro', 'file') + navLink('dlq', 'DLQ', 'inbox'),
            bodyId: 'alarmsTable',
            flush: true
        })}`,

    mount() {
        $('monitorUpdated').textContent = 'Verificando...';
        bindRefresh($('monitorRefresh'), runMonitors);
    },

    refresh: runMonitors
};

// Roda ao abrir a página e a cada 30 s (main.js), em qualquer aba: alimenta o
// indicador de conexão do topo
export async function runMonitors() {
    const results = [];
    for (const monitor of MONITORS) {
        try {
            results.push({ monitor, ...(await monitor.check()) });
        } catch (error) {
            results.push({ monitor, value: 'erro', ok: false, detail: error.message });
        }
    }
    $('monitorGrid').innerHTML = statCards(results.map(({ monitor, value, ok, detail }) => ({
        id: `monitor-${monitor.id}`, label: monitor.label, icon: monitor.icon, value, ok, detail
    })));
    renderAlarms();
    $('monitorUpdated').textContent = `Última verificação às ${nowTime()} · a cada 30 s`;
    emit('health', { healthy: Boolean(lastHealth?.ok) });
}

function renderAlarms() {
    const container = $('alarmsTable');
    if (!lastAlarms?.ok) {
        container.innerHTML = lastAlarms?.error
            ? errorState('Não foi possível ler os alarmes', lastAlarms.error)
            : emptyState('Não foi possível ler os alarmes', { icon: 'bell' });
        return;
    }
    if (!lastAlarms.items.length) {
        container.innerHTML = emptyState('Nenhum alarme configurado neste ambiente', { icon: 'bell' });
        return;
    }
    container.innerHTML = dataTable(['Alarme', 'Estado', 'Motivo', 'Atualizado'], lastAlarms.items.map(alarm => `
        <tr class="${alarm.state === 'ALARM' ? 'row-alert' : ''}">
            <td>
                <strong>${escapeHtml(alarm.name)}</strong>
                ${alarm.description ? `<div class="muted">${escapeHtml(alarm.description)}</div>` : ''}
            </td>
            <td>${statusBadge(ALARM_STATES, alarm.state)}</td>
            <td class="muted">${escapeHtml(alarm.reason || '—')}</td>
            <td class="nowrap">${alarm.updatedAt ? time(alarm.updatedAt) : '—'}</td>
        </tr>`));
}
