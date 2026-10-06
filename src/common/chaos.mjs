import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { awsClientConfig } from './aws-client.mjs';
import { DependencyUnavailableError, ValidationError } from './errors.mjs';
import { log } from './logger.mjs';

/**
 * Injeção de falhas (engenharia de caos) para ver retry, compensação, circuit
 * breaker e DLQ agindo sob controle.
 *
 * A configuração é um JSON num parâmetro do SSM (CHAOS_PARAM), lido por todas
 * as Lambdas: cada uma roda no próprio container (e, no LocalStack, os passos
 * da saga rodam fora do local-server), então um ajuste em memória não chegaria
 * a elas. Quem grava é o Gateway (PUT/DELETE /chaos, rotas de admin).
 *
 *   { "expiresAt": "<ISO>", "faults": [{ "service": "payments",
 *     "action": "processPayment", "type": "transient", "probability": 0.5 }] }
 *
 * Proteções:
 *  - CHAOS_ENABLED=false (prod, template.yaml): nem lê o SSM;
 *  - `expiresAt` obrigatório e no máximo CHAOS_MAX_MINUTES à frente: o caos
 *    desliga sozinho mesmo que ninguém lembre de desligar;
 *  - falha aberta: SSM fora do ar, parâmetro ausente ou JSON inválido = sem caos.
 */
export const CHAOS_SERVICES = ['products', 'orders', 'payments', 'stock', 'saga'];
export const CHAOS_FAULT_TYPES = ['latency', 'transient', 'crash', 'unavailable'];
export const CHAOS_MAX_MINUTES = 60;
export const CHAOS_MAX_FAULTS = 20;
export const CHAOS_MAX_LATENCY_MS = 60000;
// Mudança na config leva até este tempo para chegar a um container já quente
export const CHAOS_CACHE_TTL_MS = 10 * 1000;

const EMPTY = Object.freeze({ faults: [] });

/**
 * Valida e normaliza a config recebida (PUT /chaos). Lança ValidationError (400).
 * `action` é o nome da ação da saga, a chave `source/detail-type` do evento ou
 * `METHOD /caminho` de uma rota HTTP; sem ela, a falha vale para o serviço todo.
 */
export function validateChaosConfig(input, { now = Date.now } = {}) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.faults)) {
    throw new ValidationError('Chaos config must be an object with a faults array');
  }
  if (input.faults.length > CHAOS_MAX_FAULTS) {
    throw new ValidationError(`At most ${CHAOS_MAX_FAULTS} faults`);
  }
  const expiresAt = Date.parse(input.expiresAt);
  if (Number.isNaN(expiresAt) || expiresAt <= now()) {
    throw new ValidationError('expiresAt must be a future ISO date');
  }
  if (expiresAt > now() + CHAOS_MAX_MINUTES * 60 * 1000) {
    throw new ValidationError(`expiresAt must be at most ${CHAOS_MAX_MINUTES} minutes ahead`);
  }

  const faults = input.faults.map((fault, index) => {
    const where = `faults[${index}]`;
    if (!CHAOS_SERVICES.includes(fault?.service)) {
      throw new ValidationError(`${where}.service must be one of ${CHAOS_SERVICES.join(', ')}`);
    }
    if (!CHAOS_FAULT_TYPES.includes(fault.type)) {
      throw new ValidationError(`${where}.type must be one of ${CHAOS_FAULT_TYPES.join(', ')}`);
    }
    if (fault.action !== undefined && fault.action !== null && (typeof fault.action !== 'string' || !fault.action.trim() || fault.action.length > 100)) {
      throw new ValidationError(`${where}.action must be a non-empty string`);
    }
    const probability = fault.probability ?? 1;
    if (typeof probability !== 'number' || !(probability > 0 && probability <= 1)) {
      throw new ValidationError(`${where}.probability must be in (0, 1]`);
    }
    const latencyMs = fault.latencyMs ?? 0;
    if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > CHAOS_MAX_LATENCY_MS) {
      throw new ValidationError(`${where}.latencyMs must be an integer between 0 and ${CHAOS_MAX_LATENCY_MS}`);
    }
    if (fault.type === 'latency' && latencyMs === 0) {
      throw new ValidationError(`${where}.latencyMs is required for latency faults`);
    }
    return {
      id: typeof fault.id === 'string' && fault.id.trim() ? fault.id.trim().slice(0, 60) : `fault-${index + 1}`,
      service: fault.service,
      ...(fault.action ? { action: fault.action.trim() } : {}),
      type: fault.type,
      probability,
      latencyMs
    };
  });

  return { expiresAt: new Date(expiresAt).toISOString(), faults };
}

/**
 * Erro que cada tipo de falha lança, escolhido para seguir o caminho real:
 *  - transient: ThrottlingException (isTransientAwsError) -> TransientError,
 *    retry do Step Functions; em evento, retry da Lambda e DLQ; em HTTP, 503
 *  - crash: Error comum -> o passo da saga vai direto para a compensação; na
 *    Lambda de Products vira FunctionError e abre o circuit breaker da saga
 *  - unavailable: DependencyUnavailableError -> 503 com Retry-After
 */
export function chaosError(fault) {
  const message = `Chaos fault ${fault.id} (${fault.type}) injected`;
  if (fault.type === 'transient') return Object.assign(new Error(message), { name: 'ThrottlingException', chaos: true });
  if (fault.type === 'unavailable') return Object.assign(new DependencyUnavailableError(message, { retryAfterSeconds: 2 }), { chaos: true });
  return Object.assign(new Error(message), { name: 'ChaosError', chaos: true });
}

function matches(fault, service, action) {
  return fault.service === service && (!fault.action || fault.action === action);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled]
 * @param {string} [options.parameterName]
 * @param {import('@aws-sdk/client-ssm').SSMClient} [options.client]
 * @param {() => number} [options.now]
 * @param {() => number} [options.random]
 * @param {(ms: number) => Promise<unknown>} [options.sleep]
 * @param {number} [options.cacheTtlMs]
 */
export function createChaos({
  enabled = process.env.CHAOS_ENABLED === 'true',
  parameterName = process.env.CHAOS_PARAM,
  client,
  now = Date.now,
  random = Math.random,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  cacheTtlMs = CHAOS_CACHE_TTL_MS
} = {}) {
  let cached;
  let ssm = client;

  async function config() {
    if (cached && cached.expiresAt > now()) return cached.value;
    let value = EMPTY;
    try {
      ssm ||= new SSMClient(awsClientConfig('SSM_ENDPOINT', { maxAttempts: 1 }));
      const { Parameter } = await ssm.send(new GetParameterCommand({ Name: parameterName }));
      value = JSON.parse(Parameter?.Value || '{}');
    } catch (error) {
      // Parâmetro apagado (DELETE /chaos) é o estado normal: sem caos, sem log
      if (error?.name !== 'ParameterNotFound') {
        log({ event: 'CHAOS_CONFIG_UNAVAILABLE', status: 'debug', message: `Chaos config not read: ${error.message}` });
      }
    }
    cached = { value, expiresAt: now() + cacheTtlMs };
    return value;
  }

  /**
   * Chamado antes de cada ação/rota. Sem falha para o alvo, não faz nada; com
   * uma, espera `latencyMs` e, se não for só latência, lança o erro do tipo.
   * Vale a primeira falha que casar e for sorteada.
   */
  async function maybeInject({ service, action, correlationId }) {
    if (!enabled || !parameterName || !service) return;
    const current = await config();
    if (!Array.isArray(current.faults) || !(Date.parse(current.expiresAt) > now())) return;

    const fault = current.faults.find(f => matches(f, service, action) && random() < (f.probability ?? 1));
    if (!fault) return;

    // info, não warn: falha injetada não deve contar em BusinessErrors. O
    // erro que ela provoca é registrado normalmente por quem o recebe
    log({
      event: 'CHAOS_INJECTED',
      correlationId,
      status: 'info',
      message: `Chaos ${fault.type} on ${service}/${action ?? '*'} (${fault.id})`,
      data: { faultId: fault.id, service, action, type: fault.type, latencyMs: fault.latencyMs },
      metrics: {
        metrics: { ChaosInjected: { value: 1 } },
        dimensions: { Service: service, Fault: fault.type },
        dimensionSets: [[], ['Service', 'Fault']]
      }
    });

    if (fault.latencyMs > 0) await sleep(fault.latencyMs);
    if (fault.type !== 'latency') throw chaosError(fault);
  }

  return { maybeInject, config };
}

// Instância compartilhada pelos handlers (cache por container)
let defaultChaos;
export function getChaos() {
  defaultChaos ||= createChaos();
  return defaultChaos;
}
