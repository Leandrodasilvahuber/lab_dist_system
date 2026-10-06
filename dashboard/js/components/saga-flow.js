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

// Serviço (Lambda) que executa cada passo: scripts/generate-saga-workflow.py
const SERVICE = {
    createOrder: 'orders',
    reserveStock: 'stock',
    processPayment: 'payments',
    commitReservation: 'stock',
    confirmOrder: 'orders',
    refundPayment: 'payments',
    releaseStock: 'stock',
    cancelOrder: 'orders'
};

// Coluna de cada compensação: embaixo do passo que ela desfaz
const COMPENSATION_COLUMN = { cancelOrder: 0, releaseStock: 1, refundPayment: 2 };

const STATE_ICON = {
    running: 'clock',
    done: 'check',
    failed: 'x',
    compensated: 'undo',
    'compensation-failed': 'x'
};

const STATE_NOTE = {
    pending: 'aguardando',
    running: 'executando',
    skipped: 'não executado'
};

// Seta acesa quando o nó de destino já foi alcançado
const reached = state => !['idle', 'pending', 'skipped'].includes(state);

// Conector no vão à esquerda do elemento; `to`: para onde a seta aponta
const link = (on, { to = 'right', dashed = false, head = true } = {}) =>
    `<i class="fx-link to-${to}${on ? ' on' : ''}${dashed ? ' dashed' : ''}${head ? '' : ' no-head'}" aria-hidden="true"></i>`;

function card({ tile, glyph, name, sub, service, state, note, error }) {
    const stateIcon = STATE_ICON[state] ? icon(STATE_ICON[state], { size: 12 }) : '';
    return `
        <div class="fx-card is-${state}"${error ? ` title="${escapeHtml(error)}"` : ''}>
            <span class="fx-tile tile-${tile}">${icon(glyph, { size: 15 })}</span>
            ${service ? `<span class="fx-service">${escapeHtml(service)}</span>` : ''}
            <span class="fx-text">
                <span class="fx-name">${escapeHtml(name)}</span>
                <span class="fx-sub">${escapeHtml(sub)}</span>
            </span>
            ${note || stateIcon ? `<span class="fx-state">${stateIcon}<span>${escapeHtml(note)}</span></span>` : ''}
        </div>`;
}

function stepCard(n, skippedNote = STATE_NOTE.skipped) {
    const note = n.ms !== null && n.ms !== undefined ? duration(n.ms)
        : n.state === 'skipped' ? skippedNote : STATE_NOTE[n.state] || '';
    return card({ tile: 'lambda', glyph: 'lambda', name: n.label, sub: n.name, service: SERVICE[n.name], state: n.state, note, error: n.error });
}

const RESULT = {
    idle: ['idle', 'Resultado', ''],
    'not-started': ['failed', 'Não iniciada', 'sem execução'],
    running: ['running', 'Em andamento', 'executando'],
    compensating: ['running', 'Desfazendo', 'compensando'],
    completed: ['done', 'Concluída', 'pedido confirmado'],
    compensated: ['compensated', 'Desfeita', 'tudo devolvido'],
    'compensation-failed': ['compensation-failed', 'Compensação falhou', 'requer atenção'],
    failed: ['failed', 'Falhou', 'pedido cancelado']
};

// Ida: cinco Lambdas lado a lado, ligadas da esquerda para a direita
function forwardRow(flow) {
    return flow.forward.map((n, i) => `
        <div class="fx-cell">${i ? link(reached(n.state)) : ''}${stepCard(n)}</div>`).join('');
}

// Descida do passo que falhou até a faixa de compensação
function dropRow(failedColumn) {
    const cells = FORWARD.map((_, i) => `<div class="fx-cell">${i === failedColumn
        ? `<i class="fx-drop on${failedColumn > COMPENSATION_COLUMN.refundPayment ? ' no-head' : ''}" aria-hidden="true"></i>` : ''}</div>`).join('');
    return `<div class="fx-row fx-drops"><span class="fx-lane-label">${icon('undo', { size: 12 })}Compensação</span>${cells}</div>`;
}

// Compensação: cada uma embaixo do passo que desfaz, executando da direita
// para a esquerda. Falha depois do Pagamento entra pela direita (cotovelo)
function compensationRow(flow, failedColumn) {
    const byColumn = {};
    for (const n of flow.compensation.nodes) byColumn[COMPENSATION_COLUMN[n.name]] = n;
    const last = COMPENSATION_COLUMN.refundPayment;
    return FORWARD.map((_, i) => {
        const n = byColumn[i];
        if (n) {
            // Conector à esquerda deste cartão, apontando para o cartão anterior
            const left = i > 0 ? link(reached(byColumn[i - 1].state), { to: 'left', dashed: true }) : '';
            return `<div class="fx-cell">${left}${stepCard(n, 'não precisou')}</div>`;
        }
        if (failedColumn > last && i <= failedColumn) {
            const into = link(true, { to: 'left', dashed: true, head: i === last + 1 });
            return `<div class="fx-cell fx-path">${into}<i class="fx-${i === failedColumn ? 'elbow' : 'pass'}" aria-hidden="true"></i></div>`;
        }
        return '<div class="fx-cell fx-empty"></div>';
    }).join('');
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

/** Diagrama da saga no estilo da visão geral do console da Lambda: trigger, a state machine com as Lambdas da ida e da compensação, e o resultado. */
export function sagaDiagram(saga) {
    const flow = withoutStatus(flowState(saga));
    const [tone, text] = summary(flow);
    const compensation = flow.compensation;
    const started = !['idle', 'not-started'].includes(flow.outcome);
    const finished = TERMINAL_OUTCOMES.includes(flow.outcome);
    const failedColumn = compensation.active ? FORWARD.indexOf(flow.failedStep) : -1;
    const [resultState, resultName, resultNote] = RESULT[flow.outcome] || RESULT.running;
    return `
        <div class="fx" data-outcome="${flow.outcome}">
            <div class="fx-canvas">
                <div class="fx-node fx-trigger">
                    ${card({ tile: 'api', glyph: 'braces', name: 'API Gateway', sub: 'POST /saga/execute', state: started || finished ? 'done' : 'idle', note: started || finished ? 'recebida' : '' })}
                </div>
                <div class="fx-node fx-frame${compensation.active ? ' is-compensating' : ''}">
                    ${link(started)}
                    <div class="fx-frame-head">
                        <span class="fx-tile tile-sfn">${icon('workflow', { size: 14 })}</span>
                        <span class="fx-name">purchase-saga</span>
                        <span class="fx-sub">Step Functions</span>
                    </div>
                    <div class="fx-row fx-forward">${forwardRow(flow)}</div>
                    ${dropRow(failedColumn)}
                    <div class="fx-row fx-back${compensation.active ? ' is-active' : ''}">${compensationRow(flow, failedColumn)}</div>
                </div>
                <div class="fx-node fx-result">
                    ${link(finished)}
                    ${card({ tile: `result-${resultState}`, glyph: STATE_ICON[resultState] || 'target', name: resultName, sub: 'resultado', state: resultState, note: resultNote })}
                </div>
            </div>
            ${flow.outcome === 'idle' ? '' : `<p class="fx-summary tone-${tone}">${escapeHtml(text)}</p>`}
        </div>`;
}

// Nenhuma compra escolhida: o diagrama mostra só o caminho, sem estado nos cartões
function withoutStatus(flow) {
    if (flow.outcome !== 'idle') return flow;
    const idle = nodes => nodes.map(n => ({ ...n, state: 'idle' }));
    return { ...flow, forward: idle(flow.forward), compensation: { ...flow.compensation, nodes: idle(flow.compensation.nodes) } };
}

const TERMINAL_OUTCOMES = ['completed', 'compensated', 'compensation-failed', 'failed', 'not-started'];
