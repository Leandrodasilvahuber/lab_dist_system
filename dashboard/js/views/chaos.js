import { $ } from '../core/dom.js';
import { on } from '../core/events.js';
import { escapeHtml, time } from '../core/format.js';
import { CHAOS_FAULT_TYPES, CHAOS_PRESETS, CHAOS_SERVICES } from '../services/chaos-presets.js';
import { chaosState, clearChaos, loadChaos, saveChaos } from '../services/chaos.js';
import { badge } from '../components/badge.js';
import { dataTable } from '../components/data-table.js';
import { emptyState, errorState } from '../components/empty.js';
import { icon } from '../components/icons.js';
import { bindRefresh, panel, refreshButton, spacer, status, toolbar } from '../components/layout.js';
import { showToast } from '../components/toast.js';

// Alvos conhecidos por serviço (ações da saga, eventos e rotas). O campo aceita
// outro valor: rotas HTTP são "METHOD /caminho"; vazio vale para o serviço todo
const ACTIONS = {
    products: ['getProduct', 'GET /products', 'POST /products'],
    orders: ['createOrder', 'confirmOrder', 'cancelOrder', 'GET /orders'],
    payments: ['processPayment', 'refundPayment'],
    stock: ['reserveStock', 'commitReservation', 'releaseStock', 'products/ProductCreated', 'products/ProductDeleted', 'GET /stock'],
    saga: ['POST /saga/execute', 'GET /sagas', 'reconcileStuckSagas']
};

const DURATIONS = [5, 15, 30, 60];

export default {
    id: 'chaos',
    label: 'Caos',
    icon: 'zap',
    requiresAdmin: true,
    template: () => `
        ${toolbar(status('chaosSummary'), spacer,
            `<button type="button" class="btn btn-danger btn-sm" id="chaosClear" disabled>${icon('trash', { size: 15 })}<span>Desligar tudo</span></button>`,
            refreshButton('chaosRefresh'))}
        <div class="split">
            ${panel({
                title: 'Nova falha',
                icon: 'plus',
                body: `
                    <form id="chaosForm" class="form">
                        <div class="field">
                            <label for="chaosService">Serviço</label>
                            <select id="chaosService">${CHAOS_SERVICES.map(s => `<option value="${s}">${s}</option>`).join('')}</select>
                        </div>
                        <div class="field">
                            <label for="chaosAction">Ação, evento ou rota (vazio = serviço todo)</label>
                            <input type="text" id="chaosAction" class="input-mono" list="chaosActions" placeholder="Ex: processPayment">
                            <datalist id="chaosActions"></datalist>
                        </div>
                        <div class="field">
                            <label for="chaosType">Tipo</label>
                            <select id="chaosType">${Object.entries(CHAOS_FAULT_TYPES).map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}</select>
                        </div>
                        <div class="field">
                            <label for="chaosProbability">Probabilidade (%)</label>
                            <input type="number" id="chaosProbability" min="1" max="100" step="1" value="50" required>
                        </div>
                        <div class="field">
                            <label for="chaosLatency">Latência antes da falha (ms)</label>
                            <input type="number" id="chaosLatency" min="0" max="60000" step="100" value="0">
                        </div>
                        <div class="field">
                            <label for="chaosMinutes">Duração</label>
                            <select id="chaosMinutes">${DURATIONS.map(m => `<option value="${m}"${m === 15 ? ' selected' : ''}>${m} min</option>`).join('')}</select>
                        </div>
                        <button type="submit" class="btn btn-primary btn-block">${icon('zap', { size: 16 })}<span>Injetar falha</span></button>
                    </form>`
            })}
            <div class="stack">
                ${panel({ title: 'Falhas ativas', icon: 'alert', bodyId: 'chaosFaults', flush: true })}
                ${panel({ title: 'Experimentos prontos', icon: 'list', bodyId: 'chaosPresets' })}
            </div>
        </div>`,

    mount() {
        $('chaosService').addEventListener('change', fillActions);
        fillActions();
        $('chaosForm').addEventListener('submit', addFault);
        $('chaosFaults').addEventListener('click', removeFault);
        $('chaosPresets').addEventListener('click', applyPreset);
        $('chaosClear').addEventListener('click', clearAll);
        bindRefresh($('chaosRefresh'), loadChaos);
        $('chaosPresets').innerHTML = presetList();
        on('chaos', render);
    },

    refresh: loadChaos
};

function fillActions() {
    $('chaosActions').innerHTML = ACTIONS[$('chaosService').value].map(a => `<option value="${escapeHtml(a)}">`).join('');
}

function presetList() {
    return `<div class="chaos-presets">${CHAOS_PRESETS.map(p => `
        <div class="chaos-preset">
            <div>
                <strong>${escapeHtml(p.label)}</strong>${p.awsOnly ? ` ${badge('só na AWS', 'neutral')}` : ''}
                <p class="muted">${escapeHtml(p.hypothesis)}</p>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-preset="${p.id}">${icon('zap', { size: 14 })}<span>Ligar</span></button>
        </div>`).join('')}
    </div>`;
}

function render(state) {
    const summary = $('chaosSummary');
    const container = $('chaosFaults');
    $('chaosClear').disabled = !state.active;
    if (state.unavailable) {
        summary.textContent = '';
        container.innerHTML = errorState('Não foi possível ler a config de caos', new Error('GET /chaos falhou'));
        return;
    }
    if (!state.enabled) {
        summary.innerHTML = badge('Desativado neste ambiente', 'neutral');
        container.innerHTML = emptyState('A injeção de falhas está desligada (CHAOS_ENABLED=false, ex.: prod).');
        return;
    }
    if (!state.active) {
        summary.innerHTML = badge('Sem caos', 'ok');
        container.innerHTML = emptyState('Nenhuma falha injetada.', { icon: 'check' });
        return;
    }
    summary.innerHTML = `${badge('Caos ativo', 'warn', { pulse: true })} até ${time(state.expiresAt)}`;
    container.innerHTML = dataTable(['Serviço', 'Alvo', 'Tipo', { label: 'Prob.', className: 'num' }, { label: 'Latência', className: 'num' }, ''], state.faults.map((f, index) => `
        <tr class="level-warn">
            <td><strong>${escapeHtml(f.service)}</strong></td>
            <td class="mono">${escapeHtml(f.action || '*')}</td>
            <td>${escapeHtml(CHAOS_FAULT_TYPES[f.type] || f.type)}</td>
            <td class="num">${Math.round(f.probability * 100)}%</td>
            <td class="num">${f.latencyMs ? `${f.latencyMs} ms` : '—'}</td>
            <td><button type="button" class="btn btn-ghost btn-sm" data-remove="${index}" title="Remover">${icon('trash', { size: 14 })}</button></td>
        </tr>`));
}

// Minutos que faltam para a config atual expirar (para manter o prazo ao editar)
function remainingMinutes() {
    return Math.max(1, Math.ceil((Date.parse(chaosState.expiresAt) - Date.now()) / 60000));
}

async function save(faults, minutes, done) {
    try {
        if (faults.length) await saveChaos({ faults, minutes });
        else await clearChaos();
        showToast(done, 'success');
    } catch (error) {
        showToast(`Falhou: ${error.message}`, 'error');
    }
}

async function addFault(event) {
    event.preventDefault();
    const fault = {
        service: $('chaosService').value,
        type: $('chaosType').value,
        probability: Number($('chaosProbability').value) / 100,
        latencyMs: Number($('chaosLatency').value) || 0
    };
    const action = $('chaosAction').value.trim();
    if (action) fault.action = action;
    if (fault.type === 'latency' && !fault.latencyMs) {
        showToast('Informe a latência para uma falha do tipo Latência.', 'error');
        return;
    }
    const current = chaosState.active ? chaosState.faults : [];
    await save([...current, fault], Number($('chaosMinutes').value), 'Falha injetada');
}

async function removeFault(event) {
    const button = event.target.closest('button[data-remove]');
    if (!button) return;
    const faults = chaosState.faults.filter((_, index) => index !== Number(button.dataset.remove));
    await save(faults, remainingMinutes(), 'Falha removida');
}

async function applyPreset(event) {
    const button = event.target.closest('button[data-preset]');
    if (!button) return;
    const preset = CHAOS_PRESETS.find(p => p.id === button.dataset.preset);
    if (chaosState.active && !confirm('Substituir as falhas ativas por este experimento?')) return;
    await save(preset.faults, Number($('chaosMinutes').value), `Experimento "${preset.label}" ligado`);
}

async function clearAll() {
    if (!confirm('Desligar todas as falhas injetadas?')) return;
    await save([], 0, 'Caos desligado');
}
