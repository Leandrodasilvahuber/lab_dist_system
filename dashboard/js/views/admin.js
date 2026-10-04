import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { on } from '../core/events.js';
import { loadProducts, products } from '../services/catalog.js';
import { loading } from '../components/empty.js';
import { icon } from '../components/icons.js';
import { panel } from '../components/layout.js';
import { productGrid } from '../components/product-grid.js';
import { showToast } from '../components/toast.js';

export default {
    id: 'admin',
    label: 'Admin',
    icon: 'wrench',
    // Só aparece com a chave de admin ativa
    requiresAdmin: true,
    // Formulário e lista lado a lado: empilhados, a lista ficava abaixo da dobra
    template: () => `
        <div class="split">
            ${panel({
                title: 'Adicionar produto',
                icon: 'plus',
                body: `
                    <form id="productForm" class="form">
                        <div class="field">
                            <label for="productName">Nome do produto</label>
                            <input type="text" id="productName" required placeholder="Ex: Smartphone XYZ">
                        </div>
                        <div class="field">
                            <label for="productPrice">Preço (R$)</label>
                            <input type="number" id="productPrice" required step="0.01" min="0.01" placeholder="Ex: 999.90">
                        </div>
                        <div class="field">
                            <label for="productStock">Estoque inicial</label>
                            <input type="number" id="productStock" required min="0" step="1" placeholder="Ex: 50">
                        </div>
                        <button type="submit" class="btn btn-primary btn-block">${icon('plus', { size: 16 })}<span>Adicionar produto</span></button>
                    </form>`
            })}
            ${panel({ title: 'Produtos cadastrados', icon: 'list', bodyId: 'adminProductList', body: loading('Carregando produtos...') })}
        </div>`,

    mount() {
        $('productForm').addEventListener('submit', createProduct);
        on('products', ({ products, error }) => {
            $('adminProductList').innerHTML = productGrid({ products, error, compact: true, empty: 'Nenhum produto cadastrado ainda.' });
        });
    },

    refresh: loadProducts
};

async function createProduct(event) {
    event.preventDefault();
    try {
        await api('/products', {
            method: 'POST',
            body: JSON.stringify({
                name: $('productName').value,
                price: Number($('productPrice').value),
                stock: Number($('productStock').value)
            })
        });
        event.target.reset();
        showToast('Produto adicionado!', 'success');
        await loadProducts();
        // Na AWS o inventário chega logo depois (evento assíncrono): relê uma vez
        if (products.some(p => p.stock === undefined)) setTimeout(loadProducts, 2000);
    } catch (error) {
        showToast(`Erro ao adicionar produto: ${error.message}`, 'error');
    }
}
