import { escapeHtml, money } from '../core/format.js';
import { badge } from './badge.js';
import { emptyState, errorState } from './empty.js';
import { icon } from './icons.js';

// Estoque ainda desconhecido: na AWS o inventário de um produto novo é
// criado de forma assíncrona (ProductCreated -> EventBridge -> Stock), e
// por alguns instantes o produto existe sem item em /stock
export function stockBadge(stock) {
    if (stock === undefined) return badge('estoque pendente', 'neutral');
    if (stock === 0) return badge('esgotado', 'bad');
    return badge(`${stock} em estoque`, stock <= 5 ? 'warn' : 'ok');
}

export const stockLabel = stock => stock === undefined ? '—' : stock;

// buy: mostra o botão Comprar (data-buy-id); compact: uma linha por produto
export function productGrid({ products, error, empty, buy = false, compact = false }) {
    if (error) return errorState('Erro ao carregar produtos', error);
    if (!products.length) return emptyState(empty, { icon: 'package' });
    return `<div class="product-grid${compact ? ' compact' : ''}">${products.map(p => `
        <article class="product-card">
            <div class="product-top">
                <span class="product-thumb">${icon('package', { size: 18 })}</span>
                <div>
                    <div class="product-name">${escapeHtml(p.name)}</div>
                    <div class="product-price">${money(p.price)}</div>
                </div>
            </div>
            <div class="product-meta">${stockBadge(p.stock)}</div>
            ${buy ? `<button type="button" class="btn btn-primary btn-sm" data-buy-id="${escapeHtml(p.id)}">${icon('cart', { size: 15 })}<span>Comprar</span></button>` : ''}
        </article>`).join('')}
    </div>`;
}
