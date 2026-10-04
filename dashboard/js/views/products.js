import { $ } from '../core/dom.js';
import { on } from '../core/events.js';
import { navigate } from '../core/nav.js';
import { loadProducts } from '../services/catalog.js';
import { loading } from '../components/empty.js';
import { panel } from '../components/layout.js';
import { productGrid } from '../components/product-grid.js';
import { prefillPurchase } from './buy.js';

export default {
    id: 'products',
    label: 'Produtos',
    icon: 'package',
    template: () => panel({ title: 'Catálogo', icon: 'package', bodyId: 'productList', body: loading('Carregando produtos...') }),

    mount() {
        on('products', ({ products, error }) => {
            $('productList').innerHTML = productGrid({
                products,
                error,
                buy: true,
                empty: 'Nenhum produto. Rode npm run seed:local ou adicione na aba Admin.'
            });
        });
        // Botão Comprar: o id vem de data-buy-id (nada de JS montado em atributo)
        $('productList').addEventListener('click', event => {
            const button = event.target.closest('[data-buy-id]');
            if (!button) return;
            navigate('buy');
            prefillPurchase(button.dataset.buyId);
        });
    },

    refresh: loadProducts
};
