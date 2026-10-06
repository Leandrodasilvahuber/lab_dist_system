import { apiAll } from '../core/api.js';
import { emit } from '../core/events.js';

// Catálogo com o estoque disponível de cada produto. Compartilhado por Comprar,
// Produtos, Admin, Pedidos e Rastreio; cada carga avisa 'products'
export let products = [];

export async function loadProducts() {
    let error = null;
    try {
        // Catálogo (Products) e estoque (Stock) vêm de serviços diferentes
        const [catalog, inventory] = await Promise.all([
            apiAll('/products', 'products'),
            apiAll('/stock', 'stock').catch(() => ({ stock: [] }))
        ]);
        const available = new Map(inventory.stock.map(item => [item.productId, item.available]));
        products = catalog.products.map(p => ({ ...p, stock: available.get(p.id) }));
        products.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } catch (loadError) {
        products = [];
        error = loadError;
    }
    emit('products', { products, error });
    return products;
}

export const productNames = () => Object.fromEntries(products.map(p => [p.id, p.name]));

// Nome de uma compra ou pedido: catálogo atual, depois o nome gravado na saga.
// Com o catálogo carregado, um id sem nome é de produto excluído
export const productLabel = (names, { productId, productName }) =>
    names[productId] || productName || (products.length ? 'Produto removido' : productId);
