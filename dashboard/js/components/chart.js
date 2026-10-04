import { escapeHtml } from '../core/format.js';
import { emptyState } from './empty.js';

// Cor da k-ésima série (tokens --series-1..8 do tokens.css, que mudam com o tema)
const seriesColor = k => `var(--series-${k % 8 + 1})`;

function bucketLabel(iso, periodSeconds) {
    const date = new Date(iso);
    return periodSeconds >= 3600
        ? date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export const periodLabel = periodSeconds => periodSeconds >= 3600 ? 'hora' : `${periodSeconds / 60} min`;

// Barras empilhadas por balde de tempo; o <title> de cada barra mostra o detalhe no hover.
// series: [{ label, values (um por balde), total }]
export function stackedChart(buckets, periodSeconds, series) {
    if (!series.length) return emptyState('Nenhum registro no período', { icon: 'check', tone: 'ok' });
    const totals = buckets.map((_, i) => series.reduce((sum, s) => sum + s.values[i], 0));
    const max = Math.max(...totals, 1);
    const bars = buckets.map((bucket, i) => {
        if (!totals[i]) return '';
        let y = 100;
        const parts = series.map((s, k) => {
            const h = s.values[i] / max * 100;
            y -= h;
            return h ? `<rect x="${i + 0.12}" y="${y}" width="0.76" height="${h}" style="fill:${seriesColor(k)}"/>` : '';
        }).join('');
        const detail = series.filter(s => s.values[i]).map(s => `${s.label}: ${s.values[i]}`).join('\n');
        return `<g><title>${escapeHtml(`${bucketLabel(bucket, periodSeconds)}\n${detail}`)}</title>${parts}</g>`;
    }).join('');
    return `
        <div class="chart">
            <svg viewBox="0 0 ${buckets.length} 100" preserveAspectRatio="none" role="img" aria-label="Gráfico de barras empilhadas">${bars}</svg>
            <div class="chart-axis">
                <span>${escapeHtml(bucketLabel(buckets[0], periodSeconds))}</span>
                <span>máx ${escapeHtml(max)} por ${periodLabel(periodSeconds)}</span>
                <span>${escapeHtml(bucketLabel(buckets[buckets.length - 1], periodSeconds))}</span>
            </div>
            <div class="legend">${series.map((s, k) => `
                <span><i style="background:${seriesColor(k)}"></i>${escapeHtml(s.label)} <strong>${escapeHtml(s.total)}</strong></span>`).join('')}
            </div>
        </div>`;
}
