import { escapeHtml } from '../core/format.js';

// tone: ok | warn | bad | info | neutral
export function badge(label, tone = 'neutral', { pulse = false } = {}) {
    return `<span class="badge badge-${tone}${pulse ? ' badge-pulse' : ''}">${escapeHtml(label)}</span>`;
}

// Status conhecidos de cada domínio -> [rótulo, tom]
export const SAGA_STATUS = {
    RUNNING: ['Em andamento', 'info'],
    COMPENSATING: ['Compensando', 'warn'],
    COMPLETED: ['Concluída', 'ok'],
    COMPENSATED: ['Desfeita', 'warn'],
    FAILED: ['Falhou', 'bad'],
    COMPENSATION_FAILED: ['Compensação falhou', 'bad']
};

export const ORDER_STATUS = {
    pending: ['Pendente', 'warn'],
    confirmed: ['Confirmado', 'ok'],
    cancelled: ['Cancelado', 'bad']
};

export const ALARM_STATES = {
    OK: ['OK', 'ok'],
    ALARM: ['Em alarme', 'bad'],
    INSUFFICIENT_DATA: ['Sem dados', 'neutral']
};

export const LOG_LEVELS = {
    error: ['error', 'bad'],
    warn: ['warn', 'warn'],
    info: ['info', 'info'],
    debug: ['debug', 'neutral']
};

export function statusBadge(map, status, options) {
    const [label, tone] = map[status] || [status, 'neutral'];
    return badge(label, tone, options);
}
