import { describe, it } from 'node:test';
import assert from 'node:assert';

// config.js (via session.js) lê a API de location ao carregar
globalThis.location = { search: '', protocol: 'http:', origin: 'http://localhost:3001' };
const { sagaCard } = await import('../../../dashboard/js/components/saga-card.js');
const { sagaDiagram } = await import('../../../dashboard/js/components/saga-flow.js');
const { productGrid } = await import('../../../dashboard/js/components/product-grid.js');
const { statCard } = await import('../../../dashboard/js/components/stat-card.js');
const { emptyState, errorState } = await import('../../../dashboard/js/components/empty.js');
const { badge, statusBadge, SAGA_STATUS } = await import('../../../dashboard/js/components/badge.js');
const { dataTable } = await import('../../../dashboard/js/components/data-table.js');

// O dashboard monta HTML com template strings e innerHTML; a regra
// no-unsanitized/property fica desligada porque não enxerga o escapeHtml dentro
// dos componentes. Este teste é a garantia: dado vindo da API nunca vira tag
const PAYLOAD = '"><img src=x onerror=alert(1)>';

function assertEscaped(html) {
    assert.doesNotMatch(html, /<img/i, 'tag injetada chegou ao HTML');
    assert.doesNotMatch(html, /"\s*>\s*<img/i);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
}

describe('dashboard: dados da API são escapados', () => {
    it('card e diagrama da saga', () => {
        const saga = {
            id: PAYLOAD, productId: PAYLOAD, quantity: 1, status: 'COMPENSATED',
            createdAt: '2026-10-06T12:00:00Z', failedStep: 'processPayment',
            error: { message: PAYLOAD }, compensationError: { message: PAYLOAD },
            steps: { reserveStock: { status: 'COMPLETED' }, processPayment: { status: 'FAILED', error: { message: PAYLOAD } } }
        };
        assertEscaped(sagaCard(saga, { [PAYLOAD]: PAYLOAD }));
        assertEscaped(sagaDiagram(saga));
    });

    it('grade de produtos (nome e id em atributos data-*)', () => {
        const products = [{ id: PAYLOAD, name: PAYLOAD, price: 1, stock: 3 }];
        assertEscaped(productGrid({ products, buy: true, remove: true }));
    });

    it('erro da API em estado vazio, card e badge', () => {
        assertEscaped(errorState('Erro', new Error(PAYLOAD)));
        assertEscaped(emptyState(PAYLOAD));
        assertEscaped(statCard({ label: PAYLOAD, value: PAYLOAD, detail: PAYLOAD, id: PAYLOAD }));
        assertEscaped(badge(PAYLOAD));
        // Status desconhecido cai no rótulo cru
        assertEscaped(statusBadge(SAGA_STATUS, PAYLOAD));
    });

    it('cabeçalho de tabela', () => {
        assertEscaped(dataTable([PAYLOAD, { label: PAYLOAD }], []));
    });
});
