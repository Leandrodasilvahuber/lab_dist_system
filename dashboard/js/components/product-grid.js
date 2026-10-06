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

// buy: mostra o botão Comprar (data-buy-id); remove: o botão Remover
// (data-remove-id, aba Admin); compact: uma linha por produto
export function productGrid({ products, error, empty, buy = false, remove = false, compact = false }) {
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
            ${buy ? (p.stock === 0
                ? `<button type="button" class="btn btn-primary btn-sm" disabled title="Produto sem estoque">${icon('cart', { size: 15 })}<span>Esgotado</span></button>`
                : `<button type="button" class="btn btn-primary btn-sm" data-buy-id="${escapeHtml(p.id)}">${icon('cart', { size: 15 })}<span>Comprar</span></button>`) : ''}
            ${remove ? `<button type="button" class="btn btn-danger btn-sm" data-remove-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">${icon('trash', { size: 14 })}<span>Remover</span></button>` : ''}
        </article>`).join('')}
    </div>`;
}
