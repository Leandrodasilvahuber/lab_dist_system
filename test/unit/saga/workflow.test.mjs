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

  it('caminho feliz executa os 4 passos e termina em sucesso', () => {
    const { actions, end } = simulate(null);
    assert.deepStrictEqual(actions, ['createOrder', 'processPayment', 'reserveStock', 'confirmOrder']);
    assert.strictEqual(states[end].Type, 'Succeed');
  });

  const compensations = {
    createOrder: [],
    processPayment: ['cancelOrder'],
    reserveStock: ['refundPayment', 'cancelOrder'],
    confirmOrder: ['releaseStock', 'refundPayment', 'cancelOrder']
  };

  for (const [failAt, expected] of Object.entries(compensations)) {
    it(`falha em ${failAt} compensa só os passos anteriores: [${expected.join(', ')}]`, () => {
      const { actions, end } = simulate(failAt);
      const executed = actions.slice(actions.indexOf(failAt) + 1);
      assert.deepStrictEqual(executed, expected);
      assert.strictEqual(states[end].Type, 'Fail');
    });
  }

  it('erros de negócio não são repetidos (só falhas transitórias)', () => {
    for (const state of Object.values(states).filter(s => s.Parameters?.Payload)) {
      const retried = state.Retry.flatMap(r => r.ErrorEquals);
      for (const businessError of ['States.ALL', 'InsufficientStock', 'PaymentDeclined', 'NotFound', 'InvalidState']) {
        assert.ok(!retried.includes(businessError), `${businessError} não deveria ter retry`);
      }
    }
  });

  it('falha na compensação leva a COMPENSATION_FAILED', () => {
    for (const action of ['releaseStock', 'refundPayment', 'cancelOrder']) {
      const state = Object.values(states).find(s => s.Parameters?.Payload?.action === action);
      assert.strictEqual(state.Catch[0].Next, 'MarkCompensationFailed');
    }
  });
});
