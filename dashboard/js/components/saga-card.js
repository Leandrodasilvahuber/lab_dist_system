import { escapeHtml, time } from '../core/format.js';
import { SAGA_STATUS, statusBadge } from './badge.js';
import { icon } from './icons.js';

export const TERMINAL = ['COMPLETED', 'COMPENSATED', 'FAILED', 'COMPENSATION_FAILED'];
// Erro gravado quando o StartExecution falhou (SagaService, START_FAILED)
const START_FAILED = 'StartExecutionFailed';
export const STEP_LABELS = {
    createOrder: 'Pedido',
    reserveStock: 'Estoque',
    processPayment: 'Pagamento',
    commitReservation: 'Baixa da reserva',
    confirmOrder: 'Confirmação',
    refundPayment: 'Reembolso',
    releaseStock: 'Libera estoque',
    cancelOrder: 'Cancela pedido'
};
const FORWARD = ['createOrder', 'reserveStock', 'processPayment', 'commitReservation', 'confirmOrder'];
const COMPENSATIONS = ['refundPayment', 'releaseStock', 'cancelOrder'];
export function traceButton(id) {
    return id
        ? `<button type="button" class="icon-btn trace-btn" data-trace="${escapeHtml(id)}" title="Rastrear ${escapeHtml(id)}" aria-label="Rastrear ${escapeHtml(id)}">${icon('search', { size: 14 })}</button>`
        : '';
}

// Abre o diagrama da saga numa modal (main.js trata todo [data-flow])
export function flowButton(id) {
    return id
        ? `<button type="button" class="icon-btn flow-btn" data-flow="${escapeHtml(id)}" title="Ver fluxo" aria-label="Ver fluxo de ${escapeHtml(id)}">${icon('workflow', { size: 14 })}</button>`
        : '';
}

// Um segmento por passo: a cor diz como ele terminou, o título diz qual é
const segment = (name, state, error) =>
    `<span class="seg ${escapeHtml(state)}" title="${escapeHtml(STEP_LABELS[name] + (error ? `: ${error}` : ''))}"></span>`;

// selectable: cartão clicável da tela Comprar (escolhe a saga do diagrama, sem
// o botão da modal); selected: o que o diagrama mostra agora
export function sagaCard(saga, productNames, { selectable = false, selected = false } = {}) {
    const tone = (SAGA_STATUS[saga.status] || [])[1] || 'neutral';
    const steps = saga.steps || {};
    const running = !TERMINAL.includes(saga.status);

    // O primeiro passo ainda sem registro é o que está executando
    const nextStep = FORWARD.find(name => !steps[name]);
    const forward = FORWARD.map(name => {
        let state = steps[name]?.status || '';
        if (!state && running && saga.status === 'RUNNING' && name === nextStep) state = 'RUNNING';
        return segment(name, state, steps[name]?.error?.message);
    }).join('');

    const compensations = COMPENSATIONS.filter(name => steps[name]);
    const compensationHtml = compensations.length || saga.status === 'COMPENSATING'
        ? `<span class="segs-sep" title="Compensação">${icon('undo', { size: 11 })}</span>` + compensations
            .map(name => segment(name, steps[name].status,
                steps[name].error?.message || (steps[name].status === 'SKIPPED' ? 'nada a desfazer' : ''))).join('')
        : '';

    // StartExecutionFailed (string, sem passo): a execução nem começou
    const error = saga.error?.message
        ? `<div class="saga-error">Falhou em <strong>${escapeHtml(STEP_LABELS[saga.failedStep] || saga.failedStep)}</strong>: ${escapeHtml(saga.error.message)}</div>`
        : saga.error === START_FAILED
            ? '<div class="saga-error">A compra não chegou a iniciar.</div>'
            : '';

    return `
        <article class="saga-card tone-${tone}${selectable ? ' selectable' : ''}${selected ? ' selected' : ''}" id="saga-${escapeHtml(saga.id)}"${selectable ? ` data-saga="${escapeHtml(saga.id)}" tabindex="0" aria-pressed="${selected}"` : ''}>
            <div class="saga-header">
                <h3>${escapeHtml(productNames[saga.productId] || saga.productId)} × ${escapeHtml(saga.quantity)}</h3>
                ${statusBadge(SAGA_STATUS, saga.status, { pulse: running })}
            </div>
            <div class="saga-meta"><span>${time(saga.createdAt)}</span><span class="mono" title="${escapeHtml(saga.id)}">${escapeHtml(saga.id)}</span><span class="saga-actions">${selectable ? '' : flowButton(saga.id)}${traceButton(saga.id)}</span></div>
            <div class="segs">${forward}${compensationHtml}</div>
            ${error}
        </article>`;
}
