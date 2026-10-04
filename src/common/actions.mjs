import { log } from './logger.mjs';
import { ValidationError, isRetryable } from './errors.mjs';

/**
 * Invocação direta da Lambda pelo Step Functions: { action, input }.
 * Erros são relançados para o Step Functions decidir entre retry e compensação.
 */
// Campos que nunca vão para o log (dados de pagamento/credenciais)
const SENSITIVE_FIELDS = ['cardNumber', 'cvv', 'cardToken', 'token', 'password', 'apiKey'];

function redact(input) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) =>
    [key, SENSITIVE_FIELDS.includes(key) ? '[REDACTED]' : value]));
}

export function isActionInvocation(event) {
  return Boolean(event && typeof event.action === 'string' && !event.requestContext);
}

export async function runAction(actions, { action, input = {} }) {
  const fn = actions[action];
  if (!fn) {
    throw new ValidationError(`Unknown action: ${action}`);
  }

  log({
    event: 'ACTION_STARTED',
    correlationId: input.correlationId,
    status: 'info',
    message: `Running action ${action}`,
    data: redact(input)
  });

  try {
    const result = await fn(input);
    log({ event: 'ACTION_COMPLETED', correlationId: input.correlationId, status: 'info', message: `Action ${action} completed` });
    return result;
  } catch (error) {
    // Erro de negócio é esperado (warn); o resto é falha não tratada (error)
    log(isRetryable(error)
      ? { event: 'ACTION_FAILED', correlationId: input.correlationId, status: 'error', message: `Action ${action} failed: ${error.message}`, error }
      : { event: 'ACTION_REJECTED', correlationId: input.correlationId, status: 'warn', message: `Action ${action} rejected: ${error.message}`, error });
    throw error;
  }
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
 * fica no log e o evento é confirmado. Só falhas transitórias são relançadas
 * para o EventBridge repetir e, esgotadas as tentativas, mandar para a DLQ.
 */
export async function runEventHandler(handlers, event) {
  const key = `${event.source}/${event['detail-type']}`;
  const fn = handlers[key];
  if (!fn) {
    log({ event: 'DOMAIN_EVENT_IGNORED', status: 'info', message: `No handler for ${key}` });
    return { ignored: true };
  }
  try {
    return await runAction({ [key]: fn }, { action: key, input: event.detail || {} });
  } catch (error) {
    if (isRetryable(error)) throw error;
    log({ event: 'DOMAIN_EVENT_REJECTED', correlationId: event.detail?.correlationId, status: 'warn', message: `Event ${key} rejected: ${error.message}`, error });
    return { rejected: true, reason: error.message };
  }
}
