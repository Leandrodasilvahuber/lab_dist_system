import { apiAll } from '../core/api.js';
import { $ } from '../core/dom.js';
import { money } from '../core/format.js';
import { errorState, loading } from '../components/empty.js';
import { statCards } from '../components/stat-card.js';

export default {
    id: 'summary',
    label: 'Resumo',
    icon: 'dashboard',
    template: () => `<div class="stat-grid" id="summaryContent">${loading()}</div>`,
    refresh: fetchSummary
};

async function fetchSummary() {
    const content = $('summaryContent');
    try {
        const [{ products }, { stock }, { orders }, { sagas }] = await Promise.all([
            apiAll('/products', 'products'), apiAll('/stock', 'stock'),
            apiAll('/orders', 'orders'), apiAll('/sagas', 'sagas')
        ]);
        const totalStock = stock.reduce((sum, item) => sum + (item.available || 0), 0);
        const confirmed = orders.filter(o => o.status === 'confirmed');
        const revenue = confirmed.reduce((sum, o) => sum + (o.total || 0), 0);
        const undone = sagas.filter(s => ['COMPENSATED', 'FAILED'].includes(s.status)).length;
        content.innerHTML = statCards([
            { label: 'Produtos', value: products.length, icon: 'package', tone: 'brand', detail: 'no catálogo' },
            { label: 'Unidades em estoque', value: totalStock, icon: 'layers', tone: 'store', detail: 'disponíveis para venda' },
            { label: 'Vendido', value: money(revenue), icon: 'dollar', tone: 'ok', detail: 'pedidos confirmados' },
            { label: 'Pedidos confirmados', value: confirmed.length, icon: 'check', tone: 'info', detail: `de ${orders.length} pedidos` },
            { label: 'Compras desfeitas', value: undone, icon: 'undo', tone: 'bad', detail: 'compensadas ou falhas', ok: undone ? false : null }
        ]);
    } catch (error) {
        content.innerHTML = errorState('Erro ao carregar resumo', error);
    }
}
