import { escapeHtml } from '../core/format.js';
import { icon } from './icons.js';
import { STEP_LABELS, TERMINAL } from './saga-card.js';

// Mesma ordem do saga-workflow.asl.json (scripts/generate-saga-workflow.py)
export const FORWARD = ['createOrder', 'reserveStock', 'processPayment', 'commitReservation', 'confirmOrder'];
export const COMPENSATIONS = ['refundPayment', 'releaseStock', 'cancelOrder'];

// Passo que falhou -> primeira compensação da cadeia (COMPENSATION_ENTRY do
// gerador). createOrder não compensa: o pedido é limpo e a saga termina FAILED
const COMPENSATION_ENTRY = {
    reserveStock: 'releaseStock',
    processPayment: 'refundPayment',
    commitReservation: 'refundPayment',
    confirmOrder: 'refundPayment'
};

const START_FAILED = 'StartExecutionFailed';

const STEP_STATE = {
    COMPLETED: 'done',
    FAILED: 'failed',
    COMPENSATED: 'compensated',
    COMPENSATION_FAILED: 'compensation-failed'
};

/**
 * Estado de cada nó do diagrama a partir da saga (GET /saga/{id}).
 * Nós: pending | running | done | failed | compensated | compensation-failed | skipped.
 * `ms`: tempo do passo, do registro anterior (ou da criação) até o dele.
 */
export function flowState(saga) {
    if (!saga) {
        return {
            outcome: 'idle',
            forward: FORWARD.map(name => node(name, 'pending')),
            end: 'pending',
            compensation: { active: false, nodes: COMPENSATIONS.map(name => node(name, 'pending')), end: 'pending' }
        };
    }

    const steps = saga.steps || {};
    const status = saga.status;
    const terminal = TERMINAL.includes(status);
    const durations = stepDurations(saga);

    if (saga.error === START_FAILED) {
        return {
            outcome: 'not-started',
            forward: FORWARD.map(name => node(name, 'skipped')),
            end: 'skipped',
            compensation: { active: false, nodes: COMPENSATIONS.map(name => node(name, 'skipped')), end: 'skipped' },
            totalMs: null
        };
    }

    // Ida: registrado = o status do registro; o primeiro sem registro está
    // executando (saga RUNNING); os demais ficam pendentes, ou "não executados"
    // depois de uma falha
    const failedIndex = FORWARD.findIndex(name => steps[name]?.status === 'FAILED');
    const nextIndex = FORWARD.findIndex(name => !steps[name]);
    const forward = FORWARD.map((name, i) => {
        const recorded = steps[name];
        if (recorded) return node(name, STEP_STATE[recorded.status] || 'done', durations[name], recorded.error?.message);
        if (status === 'RUNNING' && i === nextIndex) return node(name, 'running');
        return node(name, failedIndex >= 0 || terminal ? 'skipped' : 'pending');
    });

    const failedStep = saga.failedStep || FORWARD[failedIndex];
    const entry = COMPENSATION_ENTRY[failedStep];
    const entryIndex = entry ? COMPENSATIONS.indexOf(entry) : -1;
    const compensating = entryIndex >= 0 || COMPENSATIONS.some(name => steps[name]);
    const nextCompensation = COMPENSATIONS.findIndex((name, i) => i >= Math.max(entryIndex, 0) && !steps[name]);
    const compensationNodes = COMPENSATIONS.map((name, i) => {
        const recorded = steps[name];
        if (recorded) return node(name, STEP_STATE[recorded.status] || 'compensated', durations[name], recorded.error?.message);
        if (!compensating) return node(name, terminal ? 'skipped' : 'pending');
        if (i < entryIndex) return node(name, 'skipped');
        if (status === 'COMPENSATING' && i === nextCompensation) return node(name, 'running');
        return node(name, terminal ? 'skipped' : 'pending');
    });

    const outcome = {
        RUNNING: 'running',
        COMPENSATING: 'compensating',
        COMPLETED: 'completed',
        COMPENSATED: 'compensated',
        COMPENSATION_FAILED: 'compensation-failed',
        FAILED: 'failed'
    }[status] || 'running';

    return {
        outcome,
        failedStep,
        error: saga.error?.message || null,
        compensationError: saga.compensationError?.message || null,
        forward,
        end: status === 'COMPLETED' ? 'done' : terminal || failedIndex >= 0 ? 'skipped' : 'pending',
        compensation: {
            active: compensating,
            nodes: compensationNodes,
            end: status === 'COMPENSATED' ? 'compensated'
                : status === 'COMPENSATION_FAILED' ? 'compensation-failed'
                    : compensating && !terminal ? 'pending' : 'skipped'
        },
        current: [...forward, ...compensationNodes].find(n => n.state === 'running')?.label || null,
        totalMs: terminal ? elapsed(saga.createdAt, lastStepAt(saga) || saga.updatedAt) : elapsed(saga.createdAt, Date.now())
    };
}

const node = (name, state, ms = null, error = null) => ({ name, label: STEP_LABELS[name] || name, state, ms, error });

function elapsed(from, to) {
    const ms = (typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from);
    return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

function lastStepAt(saga) {
    const times = Object.values(saga.steps || {}).map(s => s.at).filter(Boolean).sort();
    return times.at(-1) || null;
}

// Cada passo registra a hora em que terminou (`at`): a duração é a distância
// até o registro anterior, ou até a criação da saga no primeiro
function stepDurations(saga) {
    const ordered = Object.entries(saga.steps || {})
        .filter(([, s]) => s.at)
        .sort(([, a], [, b]) => a.at.localeCompare(b.at));
    const durations = {};
    let previous = saga.createdAt;
    for (const [name, step] of ordered) {
        durations[name] = elapsed(previous, step.at);
        previous = step.at;
    }
    return durations;
}

export function duration(ms) {
    if (ms === null || ms === undefined) return '';
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

const NODE_ICON = {
    pending: '',
    running: '',
    done: 'check',
    failed: 'x',
    compensated: 'undo',
    'compensation-failed': 'x',
    skipped: ''
};

const NODE_NOTE = {
    pending: 'aguardando',
    running: 'executando',
    skipped: 'não executado'
};

function nodeHtml({ label, state, ms, error }, { skippedNote = NODE_NOTE.skipped } = {}) {
    const glyph = NODE_ICON[state] ? icon(NODE_ICON[state], { size: 14 }) : '';
    const note = ms !== null && ms !== undefined ? duration(ms) : state === 'skipped' ? skippedNote : NODE_NOTE[state] || '';
    return `
        <li class="flow-node is-${state}"${error ? ` title="${escapeHtml(error)}"` : ''}>
            <span class="flow-dot">${glyph}</span>
            <span class="flow-label">${escapeHtml(label)}</span>
            <span class="flow-note">${escapeHtml(note)}</span>
        </li>`;
}

const link = state => `<li class="flow-link is-${state}" aria-hidden="true">${icon('arrowRight', { size: 14 })}</li>`;

// Seta acesa quando o nó seguinte já foi alcançado
const reached = state => !['pending', 'skipped'].includes(state);

function lane(nodes, end, endLabel, options) {
    return nodes.map((n, i) => (i ? link(reached(n.state) ? 'on' : 'off') : '') + nodeHtml(n, options)).join('')
        + link(reached(end) ? 'on' : 'off')
        + `<li class="flow-node flow-end is-${end}">
                <span class="flow-dot">${end === 'done' ? icon('check', { size: 14 }) : end === 'compensated' ? icon('undo', { size: 14 }) : end === 'compensation-failed' ? icon('x', { size: 14 }) : ''}</span>
                <span class="flow-label">${escapeHtml(endLabel)}</span>
                <span class="flow-note"></span>
            </li>`;
}

function summary(flow) {
    const total = flow.totalMs !== null && flow.totalMs !== undefined ? ` · ${duration(flow.totalMs)}` : '';
    const failedLabel = STEP_LABELS[flow.failedStep] || flow.failedStep;
    const undone = flow.compensation?.nodes.filter(n => n.state === 'compensated').map(n => n.label) || [];
    switch (flow.outcome) {
        case 'idle':
            return ['neutral', 'Faça uma compra ou escolha uma na lista para ver o caminho que ela percorreu.'];
        case 'not-started':
            return ['bad', 'A compra não chegou a iniciar.'];
        case 'running':
            return ['info', `Em andamento${flow.current ? `: ${flow.current}` : ''}${total}`];
        case 'compensating':
            return ['warn', `Falhou em ${failedLabel}, desfazendo${flow.current ? `: ${flow.current}` : ''}${total}`];
        case 'completed':
            return ['ok', `Compra concluída${total}`];
        case 'compensated':
            return ['warn', `Falhou em ${failedLabel}${flow.error ? ` (${flow.error})` : ''}. ${undone.length ? `Desfeito: ${undone.join(', ')}` : 'Nada a desfazer'}${total}`];
        case 'compensation-failed':
            return ['bad', `Falhou em ${failedLabel} e a compensação também falhou${flow.compensationError ? ` (${flow.compensationError})` : ''}${total}`];
        default:
            return ['bad', `Falhou em ${failedLabel}${flow.error ? ` (${flow.error})` : ''}${total}`];
    }
}

/** Diagrama da saga: ida, compensação e o resumo do que aconteceu. */
export function sagaDiagram(saga) {
    const flow = flowState(saga);
    const [tone, text] = summary(flow);
    const compensation = flow.compensation;
    return `
        <div class="flow" data-outcome="${flow.outcome}">
            <div class="flow-lane">
                <span class="flow-lane-title">Ida</span>
                <ol class="flow-track">${lane(flow.forward, flow.end, 'Concluída')}</ol>
            </div>
            <div class="flow-lane flow-back${compensation.active ? ' is-active' : ''}">
                <span class="flow-lane-title">${icon('undo', { size: 13 })} Compensação</span>
                <ol class="flow-track">${lane(compensation.nodes, compensation.end, 'Desfeita', { skippedNote: 'não precisou' })}</ol>
            </div>
            <p class="flow-summary tone-${tone}">${escapeHtml(text)}</p>
        </div>`;
}
