import { apiAll } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { emptyState, errorState, loading } from '../components/empty.js';
import { panel } from '../components/layout.js';
import { stockBadge } from '../components/product-grid.js';

export default {
    id: 'stock',
    label: 'Estoque',
    icon: 'layers',
    template: () => panel({ title: 'Estoque atual', icon: 'layers', bodyId: 'stockList', flush: true, body: loading('Carregando estoque...') }),
    refresh: fetchStock
};

// Barra: disponível (cor do grupo) + reservado por compras em andamento (âmbar)
function stockBar(available, reserved) {
    const total = available + (reserved || 0);
    if (!total) return '<div class="stock-bar"></div>';
    return `<div class="stock-bar" title="${escapeHtml(`${available} disponíveis · ${reserved || 0} reservados`)}">
        <i style="width:${(available / total * 100).toFixed(1)}%"></i>
        <i class="reserved" style="width:${((reserved || 0) / total * 100).toFixed(1)}%"></i>
    </div>`;
}

async function fetchStock() {
    const list = $('stockList');
    try {
        const { stock } = await apiAll('/stock', 'stock');
        stock.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        list.innerHTML = stock.length ? stock.map(item => `
            <div class="stock-row">
                <div>
                    <div class="stock-name">${escapeHtml(item.name)}</div>
                    <div class="muted">Reservado (compras em andamento): ${escapeHtml(item.reserved ?? '— (indisponível)')} · ${stockBadge(item.available)}</div>
                </div>
                <div class="stock-qty"><strong>${escapeHtml(item.available)}</strong><span>disponíveis</span></div>
                ${stockBar(item.available, item.reserved)}
            </div>`).join('') : emptyState('Nenhum produto.', { icon: 'layers' });
    } catch (error) {
        list.innerHTML = errorState('Erro ao carregar estoque', error);
    }
}
