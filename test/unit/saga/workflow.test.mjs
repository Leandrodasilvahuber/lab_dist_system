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
// Valor no caminho JSON ($.a.b) dos dados simulados
const at = (data, path) => path.slice(2).split('.').reduce((v, key) => v?.[key], data);

function matches(rule, data) {
  if (rule.And) return rule.And.every(r => matches(r, data));
  const value = at(data, rule.Variable);
  if ('IsPresent' in rule) return (value !== undefined) === rule.IsPresent;
  return value === rule.StringEquals;
}

/**
 * `skipped`: compensações que respondem SKIPPED (nada a desfazer).
 * Devolve também os registros gravados por passo (steps.<nome>).
 */
function simulate(failAt, { skipped = [] } = {}) {
  const failing = [].concat(failAt ?? []);
  const actions = [];
  const recorded = {};
  const data = {};
  let name = definition.StartAt;
  for (let i = 0; i < 100 && name; i++) {
    const state = states[name];
    if (state.Type === 'Succeed' || state.Type === 'Fail') return { actions, end: name, recorded };

    if (state.Type === 'Choice') {
      const match = state.Choices.find(c => matches(c, data));
      name = match ? match.Next : state.Default;
      continue;
    }

    const action = state.Parameters?.Payload?.action;
    if (action) actions.push(action);
    const step = state.Parameters?.ExpressionAttributeNames?.['#step'];
    if (step) recorded[step] = state.Parameters.ExpressionAttributeValues[':step'].M.status.S;

    if (action && failing.includes(action)) {
      data[state.Catch[0].ResultPath.slice(2)] = { Error: 'Simulated' };
      name = state.Catch[0].Next;
    } else {
      if (action && state.ResultPath) {
        data[state.ResultPath.slice(2)] = { Payload: { compensation: skipped.includes(action) ? 'SKIPPED' : 'COMPENSATED' } };
      }
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

  // Pagamento recusado: o reembolso roda (pode haver escrita atrasada), mas
  // sem cobrança a desfazer fica SKIPPED, não COMPENSATED
  it('compensação sem nada a desfazer é registrada como SKIPPED e a saga termina compensada', () => {
    const { recorded, end } = simulate('processPayment', { skipped: ['refundPayment'] });
    assert.deepStrictEqual(
      { refundPayment: recorded.refundPayment, releaseStock: recorded.releaseStock, cancelOrder: recorded.cancelOrder },
      { refundPayment: 'SKIPPED', releaseStock: 'COMPENSATED', cancelOrder: 'COMPENSATED' });
    assert.strictEqual(end, 'SagaCompensated');
  });

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
  // Prazo da compra (scripts/generate-saga-workflow.py): cada passo com Lambda
  // tem limite próprio, e o pior caso (todos os passos de ida esgotando as
  // tentativas e depois as 3 compensações) cabe em ~5 min, bem abaixo do teto
  // da execução, que encerra sem compensar
  it('todo passo com Lambda tem limite e o pior caso fica em ~5 min, abaixo do teto da execução', () => {
    const lambdaTasks = Object.entries(states).filter(([, s]) => s.Resource === 'arn:aws:states:::lambda:invoke');
    assert.ok(lambdaTasks.every(([, s]) => s.TimeoutSeconds === 5), 'TimeoutSeconds 5 em todos os passos com Lambda');

    // Esperas do backoff no teto do jitter
    const waits = retry => {
      let total = 0;
      for (let k = 0; k < retry.MaxAttempts; k++) {
        total += Math.min(retry.IntervalSeconds * retry.BackoffRate ** k, retry.MaxDelaySeconds);
      }
      return total;
    };
    const retrier = (name, error) => states[name].Retry.find(r => r.ErrorEquals.includes(error));
    // Transitórios: cada tentativa pode esgotar o TimeoutSeconds do passo
    const worstTransient = name => {
      const retry = retrier(name, 'States.Timeout');
      return (retry.MaxAttempts + 1) * states[name].TimeoutSeconds + waits(retry);
    };
    // Throttling: a recusa é imediata, só as esperas contam
    const worstThrottle = name => waits(retrier(name, 'Lambda.TooManyRequestsException'));
    const path = ['CreateOrder', 'ReserveStock', 'ProcessPayment', 'CommitReservation', 'ConfirmOrder',
      'RefundPayment', 'ReleaseStock', 'CancelOrder'];
    const transient = path.reduce((sum, name) => sum + worstTransient(name), 0);
    const total = transient + path.reduce((sum, name) => sum + worstThrottle(name), 0);

    assert.ok(transient <= 330, `pior caso sem throttling ${transient}s deve ficar em ~5 min`);
    assert.ok(definition.TimeoutSeconds >= total * 1.5, `teto ${definition.TimeoutSeconds}s acima do pior caso ${total}s`);
  });

  // 4 compras simultâneas no LocalStack (concorrência 2 por função) esgotavam o
  // retry dos transitórios e a compra falhava sem motivo de negócio
  it('throttling da Lambda tem retry próprio, antes dos transitórios e mais paciente', () => {
    for (const [name, state] of Object.entries(states).filter(([, s]) => s.Parameters?.Payload)) {
      const index = state.Retry.findIndex(r => r.ErrorEquals.includes('Lambda.TooManyRequestsException'));
      assert.strictEqual(index, 0, `${name}: throttling é o primeiro retrier`);
      const [throttle, transient] = state.Retry;
      assert.ok(!transient.ErrorEquals.includes('Lambda.TooManyRequestsException'), name);
      assert.ok(throttle.MaxAttempts >= 6 && throttle.MaxDelaySeconds >= 20, name);
    }
  });
});
