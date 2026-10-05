import { log } from './logger.mjs';
import { ValidationError, isRetryable } from './errors.mjs';
import { isTransientAwsError } from './aws-client.mjs';

/**
 * Invocação direta da Lambda pelo Step Functions: { action, input }.
 * Erros são relançados para o Step Functions decidir entre retry e compensação.
 */
// Campos que nunca vão para o log (dados de pagamento/credenciais)
const SENSITIVE_FIELDS = ['cardNumber', 'cvv', 'cardToken', 'token', 'password', 'apiKey'];

// Percorre objetos e arrays aninhados: { payment: { cardNumber } } também é ocultado
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) =>
    [key, SENSITIVE_FIELDS.includes(key) ? '[REDACTED]' : redact(inner)]));
}

export function isActionInvocation(event) {
  return Boolean(event && typeof event.action === 'string' && !event.requestContext);
}

/**
 * `logRejection: false` deixa o registro do erro de negócio para quem chamou
 * (runEventHandler grava DOMAIN_EVENT_REJECTED; evita linha duplicada).
 */
export async function runAction(actions, { action, input = {} }, { logRejection = true } = {}) {
  const fn = actions[action];
  if (!fn) {
    throw new ValidationError(`Unknown action: ${action}`);
  }

  log({
    event: 'ACTION_STARTED',
    correlationId: input.correlationId,
    status: 'debug',
    message: `Running action ${action}`,
    data: redact(input)
  });

  const started = Date.now();
  // Chamadas e duração por ação e resultado: latência de cada passo da saga no tempo.
  // Só o par Action+Outcome (o total por ação é a soma dos resultados): menos
  // métricas custom cobradas e a consulta não depende de casar dimensões parciais
  const actionMetrics = outcome => ({
    metrics: { ActionCount: { value: 1 }, ActionDuration: { value: Date.now() - started, unit: 'Milliseconds' } },
    dimensions: { Action: action, Outcome: outcome },
    dimensionSets: [['Action', 'Outcome']]
  });
  try {
    const result = await fn(input);
    log({ event: 'ACTION_COMPLETED', correlationId: input.correlationId, status: 'info', message: `Action ${action} completed`, data: { durationMs: Date.now() - started }, metrics: actionMetrics('ok') });
    return result;
  } catch (error) {
    // Erro de negócio é esperado (warn); o resto é falha não tratada (error)
    if (isRetryable(error)) {
      log({ event: 'ACTION_FAILED', correlationId: input.correlationId, status: 'error', message: `Action ${action} failed: ${error.message}`, error, metrics: actionMetrics('failed') });
    } else if (logRejection) {
      log({ event: 'ACTION_REJECTED', correlationId: input.correlationId, status: 'warn', message: `Action ${action} rejected: ${error.message}`, error, metrics: actionMetrics('rejected') });
    } else {
      // Quem chamou registra o warn (e conta o BusinessErrors); aqui só as métricas da ação
      log({ event: 'ACTION_REJECTED', correlationId: input.correlationId, status: 'debug', message: `Action ${action} rejected: ${error.message}`, metrics: actionMetrics('rejected') });
    }
    throw asTransient(error);
  }
}

/**
 * Falha transitória da AWS (timeout, throttling, conexão caída, 5xx) sai com
 * um nome só, TransientError, que o Retry do workflow repete
 * (scripts/generate-saga-workflow.py). Sem isso o errorType seria o do SDK
 * (TimeoutError, RequestTimeout...) ou só "Error" (ECONNRESET), e o passo iria
 * direto para a compensação. O erro original já foi registrado acima.
 */
export class TransientError extends Error {
  constructor(cause) {
    super(`${cause.name}: ${cause.message}`, { cause });
    this.name = 'TransientError';
  }
}

function asTransient(error) {
  return isTransientAwsError(error) && !(error instanceof TransientError) ? new TransientError(error) : error;
}

/**
 * Evento de domínio entregue pelo EventBridge: { source, 'detail-type', detail }.
 */
export function isDomainEvent(event) {
  return Boolean(event && typeof event.source === 'string' && typeof event['detail-type'] === 'string' && !event.requestContext);
}

/**
 * Executa o handler registrado para `<source>/<detail-type>`.
 * Eventos sem handler são ignorados. Erro de negócio não melhora com retry:
 * fica no log e o evento é confirmado. Só falhas transitórias são relançadas:
 * o EventBridge invoca a Lambda de forma assíncrona, então quem repete é a
 * própria Lambda (EventInvokeConfig no template.yaml) e, esgotadas as
 * tentativas, o destino OnFailure manda o evento para a DLQ.
 */
export async function runEventHandler(handlers, event) {
  const key = `${event.source}/${event['detail-type']}`;
  const fn = handlers[key];
  if (!fn) {
    log({ event: 'DOMAIN_EVENT_IGNORED', status: 'info', message: `No handler for ${key}` });
    return { ignored: true };
  }
  try {
    return await runAction({ [key]: fn }, { action: key, input: event.detail || {} }, { logRejection: false });
  } catch (error) {
    if (isRetryable(error)) throw error;
    log({ event: 'DOMAIN_EVENT_REJECTED', correlationId: event.detail?.correlationId, status: 'warn', message: `Event ${key} rejected: ${error.message}`, error });
    return { rejected: true, reason: error.message };
  }
}
