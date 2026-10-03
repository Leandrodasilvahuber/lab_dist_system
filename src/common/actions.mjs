import { log } from './logger.mjs';
import { ValidationError } from './errors.mjs';

/**
 * Invocação direta da Lambda pelo Step Functions: { action, input }.
 * Erros são relançados para o Step Functions decidir entre retry e compensação.
 */
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
    data: input
  });

  try {
    const result = await fn(input);
    log({ event: 'ACTION_COMPLETED', correlationId: input.correlationId, status: 'info', message: `Action ${action} completed` });
    return result;
  } catch (error) {
    log({ event: 'ACTION_FAILED', correlationId: input.correlationId, status: 'error', message: `Action ${action} failed: ${error.message}`, error });
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
 * Eventos sem handler são ignorados; erros são relançados para o EventBridge repetir.
 */
export async function runEventHandler(handlers, event) {
  const key = `${event.source}/${event['detail-type']}`;
  const fn = handlers[key];
  if (!fn) {
    log({ event: 'DOMAIN_EVENT_IGNORED', status: 'info', message: `No handler for ${key}` });
    return { ignored: true };
  }
  return runAction({ [key]: fn }, { action: key, input: event.detail || {} });
}
