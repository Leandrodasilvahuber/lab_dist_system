import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { newIdempotencyKey } from '../core/ids.js';
import { on } from '../core/events.js';
import { escapeHtml, hourMinute, money } from '../core/format.js';
import { loadProducts, productNames } from '../services/catalog.js';
import { getSaga, recentSagas } from '../services/sagas.js';
import { emptyState, errorState, loading } from '../components/empty.js';
import { icon } from '../components/icons.js';
import { panel } from '../components/layout.js';
import { stockLabel } from '../components/product-grid.js';
import { sagaCard, TERMINAL } from '../components/saga-card.js';
import { sagaDiagram } from '../components/saga-flow.js';
import { showToast } from '../components/toast.js';

// { request, key }: compra ainda sem resposta definitiva
let pendingPurchase = null;
let pollTimer = null;
let lastStatuses = {};
// Sagas exibidas, por id. O polling atualiza só as que estão em andamento
let sagaCache = new Map();
// Saga mostrada no diagrama: a compra recém-iniciada ou a clicada na lista.
// Sem escolha (ou se ela sumir da lista), vale a mais recente
let selectedId = null;

export default {
    id: 'buy',
    label: 'Comprar',
    icon: 'cart',
    template: () => `
        <div class="stack">
        ${panel({ title: 'Fluxo da compra', icon: 'workflow', body: `<div id="sagaFlow">${sagaDiagram(null)}</div>` })}
        <div class="split">
            ${panel({
                title: 'Nova compra',
                icon: 'bag',
                body: `
                    <form id="buyForm" class="form">
                        <div class="field">
                            <label for="buyProduct">Produto</label>
                            <select id="buyProduct" required><option value="">Carregando produtos...</option></select>
                        </div>
                        <div class="field">
                            <label for="buyQuantity">Quantidade</label>
                            <input type="number" id="buyQuantity" required min="1" max="1000" step="1" value="1">
                        </div>
                        <button type="submit" class="btn btn-success btn-block" id="buyButton">${icon('cart', { size: 16 })}<span>Comprar</span></button>
                    </form>`
            })}
            ${panel({ title: 'Compras', icon: 'list', body: `<div id="sagaList" class="saga-list">${loading()}</div>` })}
        </div>
        </div>`,

    mount() {
        $('buyForm').addEventListener('submit', startPurchase);
        on('products', renderProductSelect);
        // Clique (ou Enter/espaço) num cartão mostra a compra no diagrama; a
        // lupa de rastreio (data-trace) segue com o comportamento dela
        const list = $('sagaList');
        list.addEventListener('click', event => {
            if (event.target.closest('[data-trace]')) return;
            const card = event.target.closest('[data-saga]');
            if (card) selectSaga(card.dataset.saga);
        });
        list.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const card = event.target.closest('[data-saga]');
            if (!card || event.target !== card) return;
            event.preventDefault();
            selectSaga(card.dataset.saga);
        });
    },

    // Produtos antes das sagas: os cartões mostram o nome do produto
    refresh: () => loadProducts().then(() => fetchSagas())
};

function renderProductSelect({ products }) {
    const select = $('buyProduct');
    const selected = select.value;
    select.innerHTML = '<option value="">Selecione um produto</option>' + products.map(p =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} — ${money(p.price)} (estoque ${stockLabel(p.stock)})</option>`
    ).join('');
    select.value = selected;
}

// Botão Comprar da aba Produtos: chega aqui com o produto já escolhido
export function prefillPurchase(productId) {
    $('buyProduct').value = productId;
    const quantity = $('buyQuantity');
    quantity.value = 1;
    quantity.focus();
    quantity.select();
}

async function startPurchase(event) {
    event.preventDefault();
    const button = $('buyButton');
    const productId = $('buyProduct').value;
    const quantity = Number($('buyQuantity').value);

    button.disabled = true;
    // Uma chave por compra: enquanto a resposta não for definitiva (503,
    // falha de rede), repetir a mesma compra reusa a chave e retoma a
    // saga em vez de criar outra
    const request = JSON.stringify({ productId, quantity });
    try {
        // Dentro do try: uma falha aqui também cai no aviso e no finally (botão de volta)
        if (pendingPurchase?.request !== request) {
            pendingPurchase = { request, key: newIdempotencyKey() };
        }
        const result = await api('/saga/execute', {
            method: 'POST',
            headers: { 'Idempotency-Key': pendingPurchase.key },
            body: request
        });
        pendingPurchase = null;
        selectedId = result.sagaId;
        showToast('Compra iniciada! Acompanhe o fluxo acima.', 'info');
        $('buyQuantity').value = 1;
        await fetchSagas();
        $(`saga-${result.sagaId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
        const retryable = !error.status || error.status >= 500;
        if (retryable) {
            const wait = error.retryAfter ? ` em ${error.retryAfter}s` : '';
            showToast(`Compra não iniciada: ${error.message}. Tente de novo${wait} (a mesma compra será retomada)`, 'error');
        } else if (error.body?.code === 'PurchaseLimitExceeded') {
            // Limite diário (PurchaseQuota): a compra não começou; depois das 12:00 é uma compra nova
            pendingPurchase = null;
            const who = error.body.scope === 'client' ? ' para este cliente' : '';
            alert(`Total de compras do dia excedido${who} (${error.body.limit}). O limite zera às ${hourMinute(error.body.resetsAt)}.`);
        } else {
            pendingPurchase = null;
            showToast(`Compra recusada: ${error.message}`, 'error');
        }
    } finally {
        button.disabled = false;
    }
}

// Intervalo do polling das sagas em andamento. Começa em 1 s; falha de rede ou
// 5xx dobra até POLL_MAX_MS (servidor fora do ar não vira tempestade); saga em
// andamento há mais de SLOW_AFTER_MS passa a POLL_SLOW_MS (algo demorado: o
// GET /saga/{id} também corrige o status de saga parada, ver SagaService)
const POLL_MS = 1000;
const POLL_SLOW_MS = 5000;
const POLL_MAX_MS = 30000;
const SLOW_AFTER_MS = 60 * 1000;
let pollDelay = POLL_MS;

const isRunning = saga => !TERMINAL.includes(saga.status);

async function fetchSagas({ onlyRunning = false } = {}) {
    let failed = false;
    try {
        if (onlyRunning) {
            const running = [...sagaCache.values()].filter(isRunning);
            // 404: a saga sumiu (LocalStack recriado); sem tirá-la do cache, ela
            // ficaria "em andamento" e o polling não pararia nunca
            const updated = await Promise.all(running.map(s => getSaga(s.id)
                .then(saga => [s.id, saga])
                .catch(error => {
                    if (error.status === 404) return [s.id, null];
                    failed = true;
                    return [s.id, s];
                })));
            for (const [id, saga] of updated) {
                if (saga) sagaCache.set(id, saga);
                else sagaCache.delete(id);
            }
        } else {
            sagaCache = new Map((await recentSagas()).map(s => [s.id, s]));
        }
    } catch (error) {
        $('sagaList').innerHTML = errorState('Não foi possível carregar as compras', error);
        return;
    }

    const sagas = sortedSagas();
    notifyFinished(sagas);
    render(sagas);

    const running = sagas.filter(isRunning);
    const allSlow = running.every(s => Date.now() - Date.parse(s.createdAt) > SLOW_AFTER_MS);
    pollDelay = failed ? Math.min(pollDelay * 2, POLL_MAX_MS) : allSlow ? POLL_SLOW_MS : POLL_MS;
    schedulePoll(running.length > 0);
}

const sortedSagas = () => [...sagaCache.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

// Lista e diagrama a partir do cache (sem requisição)
function render(sagas = sortedSagas()) {
    const shown = sagas.slice(0, 20);
    const selected = shown.find(s => s.id === selectedId) || shown[0] || null;
    const names = productNames();
    $('sagaList').innerHTML = shown.length
        ? shown.map(s => sagaCard(s, names, { selected: s === selected })).join('')
        : emptyState('Nenhuma compra nas últimas 24 h.', { icon: 'cart' });
    $('sagaFlow').innerHTML = sagaDiagram(selected);
}

function selectSaga(id) {
    selectedId = id;
    render();
    $(`saga-${id}`)?.focus({ preventScroll: true });
}

// Continua atualizando (só as em andamento) enquanto houver saga rodando e a
// aba estiver visível; aba oculta não consulta nada (retoma ao voltar)
function schedulePoll(hasRunning) {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!hasRunning || document.hidden) return;
    pollTimer = setTimeout(() => {
        fetchSagas({ onlyRunning: true });
        loadProducts();
    }, pollDelay);
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !pollTimer && [...sagaCache.values()].some(isRunning)) {
        pollDelay = POLL_MS;
        fetchSagas({ onlyRunning: true });
    }
});

function notifyFinished(sagas) {
    for (const s of sagas) {
        const before = lastStatuses[s.id];
        if (before && !TERMINAL.includes(before) && TERMINAL.includes(s.status)) {
            if (s.status === 'COMPLETED') showToast('Compra concluída!', 'success');
            else showToast(`Compra desfeita: ${s.error?.message || s.status}`, 'error');
        }
        lastStatuses[s.id] = s.status;
    }
}
