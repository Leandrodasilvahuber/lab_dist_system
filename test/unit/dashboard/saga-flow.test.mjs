import { describe, it } from 'node:test';
import assert from 'node:assert';

// config.js (via session.js) lê a API de location ao carregar
globalThis.location = { search: '', protocol: 'http:', origin: 'http://localhost:3001' };
const { flowState, sagaDiagram, duration } = await import('../../../dashboard/js/components/saga-flow.js');

const T0 = '2026-10-06T12:00:00.000Z';
const at = seconds => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const base = { id: 'saga_1', productId: 'apple', quantity: 1, createdAt: T0 };
const states = nodes => nodes.map(n => n.state);

describe('dashboard: fluxo da saga', () => {
  it('sem saga: diagrama sem status', () => {
    const flow = flowState(null);
    assert.strictEqual(flow.outcome, 'idle');
    assert.ok(flow.forward.every(n => n.state === 'pending'));
    const html = sagaDiagram(null);
    assert.doesNotMatch(html, /fx-state|fx-summary|is-pending/);
  });

  it('concluída: todos os passos feitos, compensação não precisou, tempos por passo', () => {
    const flow = flowState({
      ...base,
      status: 'COMPLETED',
      steps: {
        createOrder: { status: 'COMPLETED', at: at(1) },
        reserveStock: { status: 'COMPLETED', at: at(1.5) },
        processPayment: { status: 'COMPLETED', at: at(3) },
        commitReservation: { status: 'COMPLETED', at: at(3.2) },
        confirmOrder: { status: 'COMPLETED', at: at(4) }
      }
    });
    assert.strictEqual(flow.outcome, 'completed');
    assert.deepStrictEqual(states(flow.forward), ['done', 'done', 'done', 'done', 'done']);
    assert.strictEqual(flow.end, 'done');
    assert.deepStrictEqual(flow.forward.map(n => n.ms), [1000, 500, 1500, 200, 800]);
    assert.strictEqual(flow.compensation.active, false);
    assert.deepStrictEqual(states(flow.compensation.nodes), ['skipped', 'skipped', 'skipped']);
    assert.strictEqual(flow.totalMs, 4000);
  });

  it('falha no estoque: libera estoque e cancela pedido; reembolso não precisou', () => {
    const flow = flowState({
      ...base,
      status: 'COMPENSATED',
      failedStep: 'reserveStock',
      error: { message: 'Insufficient stock' },
      steps: {
        createOrder: { status: 'COMPLETED', at: at(1) },
        reserveStock: { status: 'FAILED', at: at(2), error: { message: 'Insufficient stock' } },
        releaseStock: { status: 'COMPENSATED', at: at(3) },
        cancelOrder: { status: 'COMPENSATED', at: at(4) }
      }
    });
    assert.deepStrictEqual(states(flow.forward), ['done', 'failed', 'skipped', 'skipped', 'skipped']);
    assert.strictEqual(flow.end, 'skipped');
    assert.deepStrictEqual(states(flow.compensation.nodes), ['skipped', 'compensated', 'compensated']);
    assert.strictEqual(flow.compensation.end, 'compensated');
    assert.match(sagaDiagram({ ...base, status: 'COMPENSATED', failedStep: 'reserveStock', error: { message: 'Insufficient stock' }, steps: { releaseStock: { status: 'COMPENSATED', at: at(3) } } }),
      /Falhou em Estoque \(Insufficient stock\)\. Desfeito: Libera estoque/);
  });

  it('compensando: o próximo passo da cadeia aparece em execução', () => {
    const flow = flowState({
      ...base,
      status: 'COMPENSATING',
      failedStep: 'processPayment',
      steps: {
        createOrder: { status: 'COMPLETED', at: at(1) },
        reserveStock: { status: 'COMPLETED', at: at(2) },
        processPayment: { status: 'FAILED', at: at(3) },
        refundPayment: { status: 'COMPENSATED', at: at(4) }
      }
    });
    assert.deepStrictEqual(states(flow.compensation.nodes), ['compensated', 'running', 'pending']);
    assert.strictEqual(flow.current, 'Libera estoque');
    assert.strictEqual(flow.compensation.end, 'pending');
  });

  it('compensação que falhou fica marcada', () => {
    const flow = flowState({
      ...base,
      status: 'COMPENSATION_FAILED',
      failedStep: 'processPayment',
      compensationError: { message: 'Refund failed' },
      steps: {
        processPayment: { status: 'FAILED', at: at(3) },
        refundPayment: { status: 'COMPENSATION_FAILED', at: at(4) },
        releaseStock: { status: 'COMPENSATED', at: at(5) },
        cancelOrder: { status: 'COMPENSATED', at: at(6) }
      }
    });
    assert.deepStrictEqual(states(flow.compensation.nodes), ['compensation-failed', 'compensated', 'compensated']);
    assert.strictEqual(flow.compensation.end, 'compensation-failed');
  });

  it('em andamento: o primeiro passo sem registro está executando', () => {
    const flow = flowState({ ...base, status: 'RUNNING', steps: { createOrder: { status: 'COMPLETED', at: at(1) } } });
    assert.deepStrictEqual(states(flow.forward), ['done', 'running', 'pending', 'pending', 'pending']);
    assert.strictEqual(flow.current, 'Estoque');
    assert.deepStrictEqual(states(flow.compensation.nodes), ['pending', 'pending', 'pending']);
  });

  it('falha ao criar o pedido: sem compensação, saga FAILED', () => {
    const flow = flowState({ ...base, status: 'FAILED', failedStep: 'createOrder', steps: { createOrder: { status: 'FAILED', at: at(1) } } });
    assert.strictEqual(flow.outcome, 'failed');
    assert.deepStrictEqual(states(flow.forward), ['failed', 'skipped', 'skipped', 'skipped', 'skipped']);
    assert.strictEqual(flow.compensation.active, false);
  });

  it('compra que não chegou a iniciar', () => {
    const flow = flowState({ ...base, status: 'FAILED', error: 'StartExecutionFailed', steps: {} });
    assert.strictEqual(flow.outcome, 'not-started');
    assert.match(sagaDiagram({ ...base, status: 'FAILED', error: 'StartExecutionFailed', steps: {} }), /não chegou a iniciar/);
  });

  it('duração legível', () => {
    assert.strictEqual(duration(320), '320 ms');
    assert.strictEqual(duration(4210), '4,2 s');
    assert.strictEqual(duration(null), '');
  });

  it('desenha a descida até a compensação a partir do passo que falhou', () => {
    const count = (html, re) => (html.match(re) || []).length;
    // Falha na Confirmação (coluna 5): desce e vem pela direita até o Reembolso
    const late = sagaDiagram({ ...base, status: 'COMPENSATING', failedStep: 'confirmOrder', error: { message: 'x' }, steps: {} });
    assert.strictEqual(count(late, /class="fx-drop on no-head"/g), 1);
    assert.strictEqual(count(late, /class="fx-elbow"/g), 1);
    assert.strictEqual(count(late, /class="fx-pass"/g), 1);
    // Falha no Estoque: desce direto na Libera estoque, sem cotovelo
    const early = sagaDiagram({ ...base, status: 'COMPENSATING', failedStep: 'reserveStock', error: { message: 'x' }, steps: {} });
    assert.strictEqual(count(early, /class="fx-drop on"/g), 1);
    assert.doesNotMatch(early, /fx-elbow|fx-pass/);
    // Sem compensação: nenhuma descida
    assert.doesNotMatch(sagaDiagram({ ...base, status: 'COMPLETED', steps: {} }), /class="fx-drop[ "]/);
  });

  it('escapa a mensagem de erro no HTML', () => {
    const html = sagaDiagram({ ...base, status: 'FAILED', failedStep: 'createOrder', error: { message: '<img src=x>' }, steps: {} });
    assert.doesNotMatch(html, /<img/);
  });
});
