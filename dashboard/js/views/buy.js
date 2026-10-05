import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { on } from '../core/events.js';
import { escapeHtml, money } from '../core/format.js';
import { loadProducts, productNames } from '../services/catalog.js';
import { getSaga, listSagas } from '../services/sagas.js';
import { emptyState, errorState, loading } from '../components/empty.js';
import { icon } from '../components/icons.js';
import { hint, panel } from '../components/layout.js';
import { stockLabel } from '../components/product-grid.js';
import { sagaCard, TERMINAL } from '../components/saga-card.js';
import { showToast } from '../components/toast.js';

// { request, key }: compra ainda sem resposta definitiva
let pendingPurchase = null;
let pollTimer = null;
let lastStatuses = {};
// Sagas exibidas, por id. O polling atualiza só as que estão em andamento
let sagaCache = new Map();

export default {
    id: 'buy',
    label: 'Comprar',
    icon: 'cart',
    template: () => `
        <div class="split">
            <div class="stack">
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
                            <input type="number" id="buyQuantity" required min="1" step="1" value="1">
                        </div>
                        <button type="submit" class="btn btn-success btn-block" id="buyButton">${icon('cart', { size: 16 })}<span>Comprar</span></button>
                    </form>`
            })}
            ${hint(`A compra é uma <strong>saga</strong> executada pelo Step Functions:
                pedido → reserva de estoque → pagamento → baixa da reserva → confirmação.
                Se um passo falhar, ele e os anteriores são desfeitos (compensação).
                Para ver a compensação, compre o produto <em>Server</em> (pagamento recusado
                acima de R$ 10.000) ou uma quantidade maior que o estoque.`)}
            </div>
            ${panel({ title: 'Compras (sagas)', icon: 'workflow', body: `<div id="sagaList" class="saga-list">${loading()}</div>` })}
        </div>`,

    mount() {
        $('buyForm').addEventListener('submit', startPurchase);
        on('products', renderProductSelect);
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
    if (pendingPurchase?.request !== request) {
        pendingPurchase = { request, key: crypto.randomUUID() };
    }
    try {
        const result = await api('/saga/execute', {
            method: 'POST',
            headers: { 'Idempotency-Key': pendingPurchase.key },
            body: request
        });
        pendingPurchase = null;
        showToast('Compra iniciada! Acompanhe o andamento ao lado.', 'info');
        $('buyQuantity').value = 1;
        await fetchSagas();
        $(`saga-${result.sagaId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
        const retryable = !error.status || error.status >= 500;
        if (retryable) {
            const wait = error.retryAfter ? ` em ${error.retryAfter}s` : '';
            showToast(`Compra não iniciada: ${error.message}. Tente de novo${wait} (a mesma compra será retomada)`, 'error');
        } else {
            pendingPurchase = null;
            showToast(`Compra recusada: ${error.message}`, 'error');
        }
    } finally {
        button.disabled = false;
    }
}

async function fetchSagas({ onlyRunning = false } = {}) {
    try {
        if (onlyRunning) {
            const running = [...sagaCache.values()].filter(s => !TERMINAL.includes(s.status));
            // 404: a saga sumiu (LocalStack recriado); sem tirá-la do cache, ela
            // ficaria "em andamento" e o polling não pararia nunca
            const updated = await Promise.all(running.map(s => getSaga(s.id)
                .then(saga => [s.id, saga])
                .catch(error => [s.id, error.status === 404 ? null : s])));
            for (const [id, saga] of updated) {
                if (saga) sagaCache.set(id, saga);
                else sagaCache.delete(id);
            }
        } else {
            sagaCache = new Map((await listSagas()).map(s => [s.id, s]));
        }
    } catch (error) {
        $('sagaList').innerHTML = errorState('Não foi possível carregar as compras', error);
        return;
    }

    const sagas = [...sagaCache.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    notifyFinished(sagas);
    const names = productNames();
    $('sagaList').innerHTML = sagas.length
        ? sagas.slice(0, 20).map(s => sagaCard(s, names)).join('')
        : emptyState('Nenhuma compra ainda.', { icon: 'cart' });

    // Continua atualizando (só as em andamento) enquanto houver saga rodando
    clearTimeout(pollTimer);
    if (sagas.some(s => !TERMINAL.includes(s.status))) {
        pollTimer = setTimeout(() => {
            fetchSagas({ onlyRunning: true });
            loadProducts();
        }, 1000);
    }
}

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
