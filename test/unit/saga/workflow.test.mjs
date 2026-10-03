import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const definition = JSON.parse(fs.readFileSync(
  new URL('../../../src/ecommerce/saga-orchestrator/workflow/saga-workflow.asl.json', import.meta.url)
));
const states = definition.States;

/**
 * Segue o fluxo a partir de um estado, simulando falha em `failAt`,
 * e devolve as ações de Lambda executadas em ordem.
 */
function simulate(failAt) {
  const actions = [];
  let name = definition.StartAt;
  for (let i = 0; i < 100 && name; i++) {
    const state = states[name];
    if (state.Type === 'Succeed' || state.Type === 'Fail') return { actions, end: name };

    const action = state.Parameters?.Payload?.action;
    if (action) actions.push(action);

    name = action && action === failAt ? state.Catch[0].Next : state.Next;
  }
  throw new Error('fluxo não terminou');
}

describe('saga-workflow.asl.json', () => {
  it('todas as transições apontam para estados existentes', () => {
    for (const [name, state] of Object.entries(states)) {
      for (const next of [state.Next, ...(state.Catch || []).map(c => c.Next)].filter(Boolean)) {
        assert.ok(states[next], `${name} -> ${next} não existe`);
      }
    }
  });

  it('caminho feliz reserva o estoque antes de cobrar e baixa a reserva antes de confirmar', () => {
    const { actions, end } = simulate(null);
    assert.deepStrictEqual(actions, ['createOrder', 'reserveStock', 'processPayment', 'commitReservation', 'confirmOrder']);
    assert.strictEqual(states[end].Type, 'Succeed');
  });

  // A compensação inclui o próprio passo que falhou: a falha vista pelo Step
  // Functions (timeout, rede) não garante que ele não gravou nada
  const compensations = {
    createOrder: ['cancelOrder'],
    reserveStock: ['releaseStock', 'cancelOrder'],
    processPayment: ['refundPayment', 'releaseStock', 'cancelOrder'],
    commitReservation: ['refundPayment', 'releaseStock', 'cancelOrder'],
    confirmOrder: ['refundPayment', 'releaseStock', 'cancelOrder']
  };

  for (const [failAt, expected] of Object.entries(compensations)) {
    it(`falha em ${failAt} compensa o próprio passo e os anteriores: [${expected.join(', ')}]`, () => {
      const { actions, end } = simulate(failAt);
      const executed = actions.slice(actions.indexOf(failAt) + 1);
      assert.deepStrictEqual(executed, expected);
      assert.strictEqual(states[end].Type, 'Fail');
    });
  }

  it('falha no primeiro passo limpa o pedido e termina em FAILED (não COMPENSATED)', () => {
    const { end } = simulate('createOrder');
    assert.strictEqual(end, 'SagaFailed');
  });

  it('timeout da Lambda é repetido (os passos são idempotentes)', () => {
    for (const state of Object.values(states).filter(s => s.Parameters?.Payload)) {
      const retried = state.Retry.flatMap(r => r.ErrorEquals);
      assert.ok(retried.includes('Sandbox.Timedout') && retried.includes('Lambda.Unknown'));
    }
  });

  it('erros de negócio não são repetidos (só falhas transitórias)', () => {
    for (const state of Object.values(states).filter(s => s.Parameters?.Payload)) {
      const retried = state.Retry.flatMap(r => r.ErrorEquals);
      for (const businessError of ['States.ALL', 'InsufficientStock', 'PaymentDeclined', 'NotFound', 'InvalidState']) {
        assert.ok(!retried.includes(businessError), `${businessError} não deveria ter retry`);
      }
    }
  });

  it('CreateOrder recebe o preço congelado pela saga (Orders não lê produtos)', () => {
    assert.strictEqual(states.CreateOrder.Parameters.Payload.input['unitPrice.$'], '$.unitPrice');
  });

  it('falha na compensação leva a COMPENSATION_FAILED', () => {
    for (const action of ['releaseStock', 'refundPayment', 'cancelOrder']) {
      const state = Object.values(states).find(s => s.Parameters?.Payload?.action === action);
      assert.strictEqual(state.Catch[0].Next, 'MarkCompensationFailed');
    }
  });
});
