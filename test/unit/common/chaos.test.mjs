import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createChaos, chaosError, validateChaosConfig, CHAOS_CACHE_TTL_MS, CHAOS_MAX_MINUTES } from '../../../src/common/chaos.mjs';
import { isTransientAwsError } from '../../../src/common/aws-client.mjs';
import { DependencyUnavailableError, isRetryable } from '../../../src/common/errors.mjs';

process.env.LOG_LEVEL = 'silent';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const inMinutes = minutes => new Date(NOW + minutes * 60 * 1000).toISOString();

// SSM falso: devolve `config` (objeto) ou lança `error`
function fakeSsm(config, error) {
  return {
    calls: 0,
    async send() {
      this.calls++;
      if (error) throw error;
      return { Parameter: { Value: JSON.stringify(config) } };
    }
  };
}

function chaosWith(config, { random = () => 0, clock = { now: NOW }, error, enabled = true } = {}) {
  const client = fakeSsm(config, error);
  const slept = [];
  const chaos = createChaos({
    enabled,
    parameterName: '/test/ecommerce/chaos',
    client,
    now: () => clock.now,
    random,
    sleep: async ms => { slept.push(ms); }
  });
  return { chaos, client, slept };
}

const fault = extra => ({ id: 'f1', service: 'payments', action: 'processPayment', type: 'transient', probability: 1, latencyMs: 0, ...extra });

describe('chaos: seleção da falha', () => {
  it('injeta só no serviço e na ação configurados', async () => {
    const { chaos } = chaosWith({ expiresAt: inMinutes(10), faults: [fault()] });
    await assert.rejects(chaos.maybeInject({ service: 'payments', action: 'processPayment' }), { name: 'ThrottlingException' });
    await chaos.maybeInject({ service: 'payments', action: 'refundPayment' });
    await chaos.maybeInject({ service: 'stock', action: 'processPayment' });
  });

  it('sem action, vale para todas as ações e rotas do serviço', async () => {
    const { chaos } = chaosWith({ expiresAt: inMinutes(10), faults: [fault({ action: undefined, type: 'crash' })] });
    await assert.rejects(chaos.maybeInject({ service: 'payments', action: 'refundPayment' }), { name: 'ChaosError' });
    await assert.rejects(chaos.maybeInject({ service: 'payments', action: 'GET /payments' }), { name: 'ChaosError' });
  });

  it('respeita a probabilidade (random injetado)', async () => {
    const config = { expiresAt: inMinutes(10), faults: [fault({ probability: 0.3 })] };
    await chaosWith(config, { random: () => 0.5 }).chaos.maybeInject({ service: 'payments', action: 'processPayment' });
    await assert.rejects(chaosWith(config, { random: () => 0.2 }).chaos.maybeInject({ service: 'payments', action: 'processPayment' }));
  });

  it('latency só espera; os outros tipos esperam latencyMs e depois falham', async () => {
    const slow = chaosWith({ expiresAt: inMinutes(10), faults: [fault({ type: 'latency', latencyMs: 1500 })] });
    await slow.chaos.maybeInject({ service: 'payments', action: 'processPayment' });
    assert.deepStrictEqual(slow.slept, [1500]);

    const slowThenFail = chaosWith({ expiresAt: inMinutes(10), faults: [fault({ type: 'crash', latencyMs: 200 })] });
    await assert.rejects(slowThenFail.chaos.maybeInject({ service: 'payments', action: 'processPayment' }));
    assert.deepStrictEqual(slowThenFail.slept, [200]);
  });
});

describe('chaos: proteções', () => {
  it('config expirada não injeta nada', async () => {
    const { chaos } = chaosWith({ expiresAt: inMinutes(-1), faults: [fault()] });
    await chaos.maybeInject({ service: 'payments', action: 'processPayment' });
  });

  it('CHAOS_ENABLED=false (prod) nem lê o SSM', async () => {
    const { chaos, client } = chaosWith({ expiresAt: inMinutes(10), faults: [fault()] }, { enabled: false });
    await chaos.maybeInject({ service: 'payments', action: 'processPayment' });
    assert.strictEqual(client.calls, 0);
  });

  it('falha aberta: SSM fora do ar ou parâmetro ausente = sem caos', async () => {
    for (const error of [new Error('timeout'), Object.assign(new Error('missing'), { name: 'ParameterNotFound' })]) {
      const { chaos } = chaosWith(null, { error });
      await chaos.maybeInject({ service: 'payments', action: 'processPayment' });
    }
  });

  it('guarda a config por CHAOS_CACHE_TTL_MS', async () => {
    const clock = { now: NOW };
    const { chaos, client } = chaosWith({ expiresAt: inMinutes(10), faults: [] }, { clock });
    await chaos.maybeInject({ service: 'payments', action: 'x' });
    await chaos.maybeInject({ service: 'payments', action: 'x' });
    assert.strictEqual(client.calls, 1);
    clock.now += CHAOS_CACHE_TTL_MS + 1;
    await chaos.maybeInject({ service: 'payments', action: 'x' });
    assert.strictEqual(client.calls, 2);
  });
});

describe('chaos: erro de cada tipo segue o caminho real', () => {
  const f = type => ({ id: 'f', type });

  it('transient é falha transitória da AWS (retry do Step Functions, 503, DLQ)', () => {
    assert.ok(isTransientAwsError(chaosError(f('transient'))));
  });

  it('crash é erro comum: não é transitório (o passo vai para a compensação), mas é retryable em evento', () => {
    const error = chaosError(f('crash'));
    assert.ok(!isTransientAwsError(error));
    assert.ok(isRetryable(error));
  });

  it('unavailable é DependencyUnavailableError (503 com Retry-After)', () => {
    assert.ok(chaosError(f('unavailable')) instanceof DependencyUnavailableError);
  });
});

describe('validateChaosConfig', () => {
  const now = () => NOW;

  it('normaliza: id padrão, probability 1 e latencyMs 0', () => {
    const config = validateChaosConfig({ expiresAt: inMinutes(5), faults: [{ service: 'stock', type: 'crash' }] }, { now });
    assert.deepStrictEqual(config, {
      expiresAt: inMinutes(5),
      faults: [{ id: 'fault-1', service: 'stock', type: 'crash', probability: 1, latencyMs: 0 }]
    });
  });

  it('exige expiresAt no futuro e no máximo CHAOS_MAX_MINUTES à frente', () => {
    const faults = [{ service: 'stock', type: 'crash' }];
    assert.throws(() => validateChaosConfig({ faults }, { now }), /expiresAt/);
    assert.throws(() => validateChaosConfig({ expiresAt: inMinutes(-1), faults }, { now }), /expiresAt/);
    assert.throws(() => validateChaosConfig({ expiresAt: inMinutes(CHAOS_MAX_MINUTES + 1), faults }, { now }), /at most/);
  });

  it('recusa serviço, tipo, probabilidade e latência inválidos', () => {
    const base = { service: 'stock', type: 'crash' };
    for (const bad of [{ service: 'billing' }, { type: 'explode' }, { probability: 0 }, { probability: 1.5 }, { latencyMs: -1 }, { latencyMs: 60001 }, { type: 'latency' }]) {
      assert.throws(() => validateChaosConfig({ expiresAt: inMinutes(5), faults: [{ ...base, ...bad }] }, { now }), { statusCode: 400 }, JSON.stringify(bad));
    }
  });
});
