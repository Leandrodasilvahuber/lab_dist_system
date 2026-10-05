import { escapeHtml } from '../core/format.js';
import { emptyState } from './empty.js';

// Cor da k-ésima série (tokens --series-1..8 do tokens.css, que mudam com o tema)
const seriesColor = k => `var(--series-${k % 8 + 1})`;

function bucketLabel(iso, periodSeconds) {
    const date = new Date(iso);
    // Baldes diários são dias UTC (Cost Explorer): no fuso local virariam o dia anterior
    if (periodSeconds >= 86400) return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
    return periodSeconds >= 3600
        ? date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export const periodLabel = periodSeconds => periodSeconds >= 86400 ? 'dia' : periodSeconds >= 3600 ? 'hora' : `${periodSeconds / 60} min`;

const axis = (buckets, periodSeconds, middle) => `
    <div class="chart-axis">
        <span>${escapeHtml(bucketLabel(buckets[0], periodSeconds))}</span>
        <span>${escapeHtml(middle)}</span>
        <span>${escapeHtml(bucketLabel(buckets[buckets.length - 1], periodSeconds))}</span>
    </div>`;

const legend = (series, format) => `
    <div class="legend">${series.map((s, k) => `
        <span><i style="background:${seriesColor(k)}"></i>${escapeHtml(s.label)} <strong>${escapeHtml(format(s.total))}</strong></span>`).join('')}
    </div>`;

// Barras empilhadas por balde de tempo; o <title> de cada barra mostra o detalhe no hover.
// series: [{ label, values (um por balde), total }]; format: como escrever os valores
export function stackedChart(buckets, periodSeconds, series, { format = v => v } = {}) {
    if (!series.length) return emptyState('Nenhum registro no período', { icon: 'check', tone: 'ok' });
    const totals = buckets.map((_, i) => series.reduce((sum, s) => sum + s.values[i], 0));
    // Sem nenhum valor, escala 1 (evita divisão por zero e um "máx 0" no eixo)
    const max = Math.max(...totals) || 1;
    const bars = buckets.map((bucket, i) => {
        if (!totals[i]) return '';
        let y = 100;
        const parts = series.map((s, k) => {
            const h = s.values[i] / max * 100;
            y -= h;
            return h ? `<rect x="${i + 0.12}" y="${y}" width="0.76" height="${h}" style="fill:${seriesColor(k)}"/>` : '';
        }).join('');
        const detail = series.filter(s => s.values[i]).map(s => `${s.label}: ${format(s.values[i])}`).join('\n');
        return `<g><title>${escapeHtml(`${bucketLabel(bucket, periodSeconds)}\n${detail}`)}</title>${parts}</g>`;
    }).join('');
    return `
        <div class="chart">
            <svg viewBox="0 0 ${buckets.length} 100" preserveAspectRatio="none" role="img" aria-label="Gráfico de barras empilhadas">${bars}</svg>
            ${axis(buckets, periodSeconds, `máx ${format(max)} por ${periodLabel(periodSeconds)}`)}
            ${legend(series, format)}
        </div>`;
}

/**
 * Uma linha por série; null no balde = sem dado. A linha liga os pontos por
 * cima das lacunas (métrica esparsa, como a memória entre invocações, viraria
 * só traços soltos), e um ponto sozinho vira um traço curto.
 * refLines: [{ value, label }] em tracejado (ex.: limite de memória); a escala
 * inclui as referências, para o limite sempre aparecer. Cada balde tem uma
 * faixa invisível com <title> que mostra todas as séries no hover.
 * series: [{ label, values, total }]; total vai para a legenda
 */
export function lineChart(buckets, periodSeconds, series, { refLines = [], format = v => v } = {}) {
    if (!series.length) return emptyState('Nenhum registro no período', { icon: 'check', tone: 'ok' });
    const points = series.flatMap(s => s.values.filter(v => v !== null));
    const max = (Math.max(...points, ...refLines.map(r => r.value)) || 1) * 1.08;
    const n = buckets.length;
    const x = i => i + 0.5;
    const y = v => 100 - v / max * 100;

    const lines = series.map((s, k) => {
        const pts = s.values.map((v, i) => [i, v]).filter(([, v]) => v !== null);
        if (!pts.length) return '';
        const d = pts.length === 1
            ? `M${x(pts[0][0]) - 0.3} ${y(pts[0][1])}H${x(pts[0][0]) + 0.3}`
            : `M${pts.map(([i, v]) => `${x(i)} ${y(v)}`).join('L')}`;
        return `<path d="${d}" fill="none" vector-effect="non-scaling-stroke" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" style="stroke:${seriesColor(k)}"/>`;
    }).join('');

    const refs = refLines.map(r => `
        <line x1="0" x2="${n}" y1="${y(r.value)}" y2="${y(r.value)}" class="chart-ref" vector-effect="non-scaling-stroke"><title>${escapeHtml(`${r.label}: ${format(r.value)}`)}</title></line>`).join('');

    const hover = buckets.map((bucket, i) => {
        const detail = series.filter(s => s.values[i] !== null).map(s => `${s.label}: ${format(s.values[i])}`).join('\n');
        return detail
            ? `<rect x="${i}" y="0" width="1" height="100" fill="transparent"><title>${escapeHtml(`${bucketLabel(bucket, periodSeconds)}\n${detail}`)}</title></rect>`
            : '';
    }).join('');

    const refText = refLines.map(r => `${r.label} ${format(r.value)}`).join(' · ');
    return `
        <div class="chart">
            <svg viewBox="0 0 ${n} 100" preserveAspectRatio="none" role="img" aria-label="Gráfico de linhas">${refs}${lines}${hover}</svg>
            ${axis(buckets, periodSeconds, refText ? `por ${periodLabel(periodSeconds)} · ${refText}` : `por ${periodLabel(periodSeconds)}`)}
            ${legend(series, format)}
        </div>`;
}
