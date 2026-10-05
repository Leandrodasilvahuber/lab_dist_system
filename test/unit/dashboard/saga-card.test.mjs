import { describe, it } from 'node:test';
import assert from 'node:assert';

// config.js (via session.js) lê a API de location ao carregar
globalThis.location = { search: '', protocol: 'http:', origin: 'http://localhost:3001' };
const { sagaCard } = await import('../../../dashboard/js/components/saga-card.js');

const base = { id: 'saga_1', productId: 'apple', quantity: 1, createdAt: '2026-10-05T12:00:00Z', steps: {} };

describe('dashboard: card da saga', () => {
  it('saga que não chegou a iniciar explica o motivo', () => {
    const html = sagaCard({ ...base, status: 'FAILED', error: 'StartExecutionFailed' }, {});
    assert.match(html, /não chegou a iniciar/);
  });

  it('falha num passo mostra o passo e a mensagem', () => {
    const html = sagaCard({ ...base, status: 'COMPENSATED', failedStep: 'processPayment', error: { message: 'Payment declined' } }, {});
    assert.match(html, /Falhou em <strong>Pagamento<\/strong>: Payment declined/);
    assert.doesNotMatch(html, /não chegou a iniciar/);
  });
});
