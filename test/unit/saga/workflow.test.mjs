import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const definition = JSON.parse(fs.readFileSync(
  new URL('../../../src/ecommerce/saga-orchestrator/workflow/saga-workflow.asl.json', import.meta.url)
));
const states = definition.States;

/**
 * Segue o fluxo a partir de um estado, simulando falha nas ações de `failAt`
 * (uma ação ou uma lista), e devolve as ações de Lambda executadas em ordem.
 */
function simulate(failAt) {
  const failing = [].concat(failAt ?? []);
  const actions = [];
  const data = {};
  let name = definition.StartAt;
  for (let i = 0; i < 100 && name; i++) {
    const state = states[name];
    if (state.Type === 'Succeed' || state.Type === 'Fail') return { actions, end: name };

    if (state.Type === 'Choice') {
      const match = state.Choices.find(c => (c.Variable.slice(2) in data) === c.IsPresent);
      name = match ? match.Next : state.Default;
      continue;
    }

    const action = state.Parameters?.Payload?.action;
    if (action) actions.push(action);

    if (action && failing.includes(action)) {
      data[state.Catch[0].ResultPath.slice(2)] = { Error: 'Simulated' };
      name = state.Catch[0].Next;
    } else {
      name = state.Next;
    }
  }
  throw new Error('fluxo não terminou');
}

describe('saga-workflow.asl.json', () => {
  it('todas as transições apontam para estados existentes', () => {
    for (const [name, state] of Object.entries(states)) {
      const targets = [state.Next, state.Default, ...(state.Catch || []).map(c => c.Next), ...(state.Choices || []).map(c => c.Next)];
      for (const next of targets.filter(Boolean)) {
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

  it('retries usam backoff exponencial com jitter completo e teto', () => {
    for (const state of Object.values(states).filter(s => s.Retry)) {
      for (const retry of state.Retry) {
        assert.strictEqual(retry.JitterStrategy, 'FULL');
        assert.ok(retry.BackoffRate > 1 && retry.MaxDelaySeconds > 0);
      }
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

  it('falha numa compensação não impede as seguintes e leva a COMPENSATION_FAILED', () => {
    for (const failed of ['refundPayment', 'releaseStock', 'cancelOrder']) {
      const { actions, end } = simulate(['processPayment', failed]);
      assert.deepStrictEqual(actions.slice(actions.indexOf('processPayment') + 1), ['refundPayment', 'releaseStock', 'cancelOrder']);
      assert.strictEqual(end, 'CompensationFailed', `falha em ${failed}`);
    }
  });

  it('falha na limpeza do pedido (primeiro passo) leva a COMPENSATION_FAILED', () => {
    // createOrder e cancelOrder falham: a limpeza não conseguiu cancelar
    assert.strictEqual(simulate(['createOrder', 'cancelOrder']).end, 'CompensationFailed');
  });

  it('a saga concluída remove o erro de uma tentativa de início dada como falha', () => {
    assert.match(states.MarkCompleted.Parameters.UpdateExpression, /REMOVE #error/);
  });
});
