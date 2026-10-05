import { escapeHtml, time } from '../core/format.js';
import { getAdminKey } from '../core/session.js';
import { SAGA_STATUS, statusBadge } from './badge.js';
import { icon } from './icons.js';

export const TERMINAL = ['COMPLETED', 'COMPENSATED', 'FAILED', 'COMPENSATION_FAILED'];
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
const ARROW = `<span class="arrow">${icon('arrowRight', { size: 13 })}</span>`;

// O rastreio (GET /trace) é de admin: sem a chave, a lupa não aparece
export function traceButton(id) {
    return id && getAdminKey()
        ? `<button type="button" class="icon-btn trace-btn" data-trace="${escapeHtml(id)}" title="Rastrear ${escapeHtml(id)}" aria-label="Rastrear ${escapeHtml(id)}">${icon('search', { size: 14 })}</button>`
        : '';
}

const stepChip = (name, state, error) =>
    `<span class="step ${escapeHtml(state)}" title="${escapeHtml(error || '')}">${STEP_LABELS[name]}</span>`;

export function sagaCard(saga, productNames) {
    const tone = (SAGA_STATUS[saga.status] || [])[1] || 'neutral';
    const steps = saga.steps || {};
    const running = !TERMINAL.includes(saga.status);

    // O primeiro passo ainda sem registro é o que está executando
    const nextStep = FORWARD.find(name => !steps[name]);
    const forward = FORWARD.map(name => {
        let state = steps[name]?.status || '';
        if (!state && running && saga.status === 'RUNNING' && name === nextStep) state = 'RUNNING';
        return stepChip(name, state, steps[name]?.error?.message);
    }).join(ARROW);

    const compensations = COMPENSATIONS.filter(name => steps[name]);
    const compensationHtml = compensations.length || saga.status === 'COMPENSATING'
        ? '<div class="steps-label">Compensação</div>' + compensations
            .map(name => stepChip(name, steps[name].status, steps[name].error?.message)).join(ARROW)
        : '';

    const error = saga.error?.message
        ? `<div class="saga-error">Falhou em <strong>${escapeHtml(STEP_LABELS[saga.failedStep] || saga.failedStep)}</strong>: ${escapeHtml(saga.error.message)}</div>`
        : '';

    return `
        <article class="saga-card tone-${tone}" id="saga-${escapeHtml(saga.id)}">
            <div class="saga-header">
                <h3>${escapeHtml(productNames[saga.productId] || saga.productId)} × ${escapeHtml(saga.quantity)}</h3>
                ${statusBadge(SAGA_STATUS, saga.status, { pulse: running })}
            </div>
            <div class="saga-meta"><span>${time(saga.createdAt)}</span><span>·</span><span class="mono">${escapeHtml(saga.id)}</span>${traceButton(saga.id)}</div>
            <div class="steps">${forward}${compensationHtml}</div>
            ${error}
        </article>`;
}
