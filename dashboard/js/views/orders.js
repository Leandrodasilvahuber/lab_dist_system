import { apiAll } from '../core/api.js';
import { $ } from '../core/dom.js';
import { dateTime, escapeHtml, money } from '../core/format.js';
import { loadProducts, productNames, products } from '../services/catalog.js';
import { ORDER_STATUS, statusBadge } from '../components/badge.js';
import { dataTable } from '../components/data-table.js';
import { emptyState, errorState, loading } from '../components/empty.js';
import { panel } from '../components/layout.js';

export default {
    id: 'orders',
    label: 'Pedidos',
    icon: 'receipt',
    template: () => panel({ title: 'Pedidos', icon: 'receipt', bodyId: 'orderList', flush: true, body: loading('Carregando pedidos...') }),
    refresh: fetchOrders
};

async function fetchOrders() {
    const list = $('orderList');
    try {
        const [{ orders }] = await Promise.all([apiAll('/orders', 'orders'), products.length ? null : loadProducts()]);
        const names = productNames();
        orders.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        list.innerHTML = orders.length ? dataTable(
            ['Produto', 'Status', { label: 'Total', className: 'num' }, 'Criado em', 'Pedido'],
            orders.map(order => `
                <tr>
                    <td><strong>${escapeHtml(names[order.productId] || order.productId)}</strong> × ${escapeHtml(order.quantity)}</td>
                    <td>${statusBadge(ORDER_STATUS, order.status)}</td>
                    <td class="num">${money(order.total)}</td>
                    <td class="nowrap">${dateTime(order.createdAt)}</td>
                    <td class="mono muted">${escapeHtml(order.id)}</td>
                </tr>`)
        ) : emptyState('Nenhum pedido ainda.', { icon: 'receipt' });
    } catch (error) {
        list.innerHTML = errorState('Erro ao carregar pedidos', error);
    }
}
