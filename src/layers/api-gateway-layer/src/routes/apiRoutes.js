import { successResponse, errorResponse, notFoundResponse } from '../../../../common/response.mjs';
import { DomainError } from '../../../../common/errors.mjs';
import { normalizeHttpEvent } from '../../../../common/http-event.mjs';
import { log } from '../../../../common/logger.mjs';
import { withRuntimeMetrics } from '../../../../common/runtime-metrics.mjs';
import { AlarmsClient } from '../services/AlarmsClient.js';
import { LogsClient } from '../services/LogsClient.js';
import { DlqClient } from '../services/DlqClient.js';
import { SagaMetricsClient } from '../services/SagaMetricsClient.js';
import { CloudWatchMetricsClient, parseMetricsQuery } from '../services/CloudWatchMetricsClient.js';
import { SloClient, parseSloQuery } from '../services/SloClient.js';
import { MemoryMetricsClient } from '../services/MemoryMetricsClient.js';
import { CostClient, parseCostQuery } from '../services/CostClient.js';
import { ChaosClient } from '../services/ChaosClient.js';
import { parseLogQuery, isTraceId } from '../../../../common/log-query.mjs';

/**
 * Gateway centralizado.
 *
 * No HttpApi cada rota (/products, /orders, /payments, /stock, /saga...) é
 * ligada diretamente à Lambda do serviço. Esta função atende o health check,
 * os alarmes, os logs de erro e o rastreio por correlationId (CloudWatch Logs),
 * as métricas de erros e ações (CloudWatch, gravadas via EMF), a DLQ dos
 * eventos de produto, as métricas de desempenho da saga (histórico do Step Functions),
 * os SLOs (tabela de sagas e DLQ), a memória das Lambdas e o custo (estimado
 * pelas métricas e, na AWS, o real do Cost Explorer), a configuração de caos
 * (injeção de falhas, src/common/chaos.mjs) e
 * tudo o que não casar com nenhuma rota ({proxy+}), devolvendo a lista de
 * endpoints disponíveis.
 */
const AVAILABLE_ENDPOINTS = [
  'GET  /health',
  'GET  /alarms',
  'GET  /logs',
  'GET  /metrics/sagas',
  'GET  /metrics/errors',
  'GET  /metrics/slo',
  'GET  /metrics/memory',
  'GET  /metrics/cost',
  'POST /metrics/cost/refresh',
  'GET  /trace/{correlationId}',
  'GET  /dlq',
  'POST /dlq/{messageId}/redrive',
  'POST /dlq/{messageId}/discard',
  'GET  /chaos',
  'PUT  /chaos',
  'DELETE /chaos',
  'GET  /products',
  'POST /products',
  'DELETE /products/{id}',
  'GET  /products/{id}',
  'GET  /orders',
  'GET  /orders/{id}',
  'GET  /stock',
  'GET  /stock/{productId}',
  'POST /stock/{productId}/adjust',
  'POST /saga/execute',
  'GET  /saga/{sagaId}',
  'GET  /sagas'
];

export function createAPIHandler({
  alarms = new AlarmsClient(),
  logs = new LogsClient(),
  dlq = new DlqClient(),
  sagaMetrics = new SagaMetricsClient(),
  metrics = new CloudWatchMetricsClient(),
  slo = new SloClient(),
  memory = new MemoryMetricsClient(),
  cost = new CostClient(),
  chaos = new ChaosClient()
} = {}) {
  return async function handleAPIRequest(rawEvent) {
    // Regra agendada (RefreshCost no template.yaml): lê o Cost Explorer e grava o resultado
    if (rawEvent?.action === 'refreshCost') return refreshCost(cost);

    const event = normalizeHttpEvent(rawEvent);

    if (event.method === 'GET' && event.path === '/health') {
      return successResponse({ status: 'healthy', timestamp: new Date().toISOString() });
    }

    if (event.method === 'GET' && event.path === '/alarms') {
      try {
        return successResponse({ alarms: await alarms.listAlarms() });
      } catch (error) {
        log({ event: 'ALARMS_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: 'Could not read CloudWatch alarms', error });
        return errorResponse('Alarms unavailable', 503);
      }
    }

    if (event.method === 'GET' && event.path === '/logs') {
      try {
        return successResponse({ logs: await logs.listLogs(parseLogQuery(event.queryStringParameters)) });
      } catch (error) {
        log({ event: 'LOGS_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: 'Could not read CloudWatch logs', error });
        return errorResponse('Logs unavailable', 503);
      }
    }

    // tempos por passo das últimas compras (ids das sagas e erros internos)
    if (event.method === 'GET' && event.path === '/metrics/sagas') {
      try {
        return successResponse(await sagaMetrics.recentMetrics());
      } catch (error) {
        log({ event: 'SAGA_METRICS_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: 'Could not read Step Functions executions', error });
        return errorResponse('Saga metrics unavailable', 503);
      }
    }

    // séries de erros por tipo e chamadas/duração por ação
    if (event.method === 'GET' && event.path === '/metrics/errors') {
      try {
        return successResponse(await metrics.errorMetrics(parseMetricsQuery(event.queryStringParameters)));
      } catch (error) {
        log({ event: 'ERROR_METRICS_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: 'Could not read CloudWatch metrics', error });
        return errorResponse('Metrics unavailable', 503);
      }
    }

    // SLOs (latência e desfecho das compras, mensagens esquecidas na DLQ)
    if (event.method === 'GET' && event.path === '/metrics/slo') {
      try {
        return successResponse(await slo.evaluate(parseSloQuery(event.queryStringParameters)));
      } catch (error) {
        log({ event: 'SLO_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: 'Could not evaluate SLOs', error });
        return errorResponse('SLOs unavailable', 503);
      }
    }

    // memória usada por Lambda (MemoryUsedMB, gravada via EMF)
    if (event.method === 'GET' && event.path === '/metrics/memory') {
      try {
        return successResponse(await memory.memoryMetrics(parseMetricsQuery(event.queryStringParameters)));
      } catch (error) {
        log({ event: 'MEMORY_METRICS_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: 'Could not read memory metrics', error });
        return errorResponse('Memory metrics unavailable', 503);
      }
    }

    // custo por serviço e por dia: estimado (métricas) e real (Cost Explorer, só AWS)
    if (event.method === 'GET' && event.path === '/metrics/cost') {
      try {
        // apiId do HttpApi que recebeu a requisição: requisições na estimativa
        const apiId = rawEvent?.requestContext?.apiId;
        return successResponse(await cost.costs({ ...parseCostQuery(event.queryStringParameters), apiId }));
      } catch (error) {
        log({ event: 'COST_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: 'Could not estimate costs', error });
        return errorResponse('Costs unavailable', 503);
      }
    }

    // admin: lê o Cost Explorer agora, no máximo uma vez a cada 15 min
    if (event.method === 'POST' && event.path === '/metrics/cost/refresh') {
      try {
        const result = await cost.refreshActual();
        if (result.refreshed) return successResponse(result);
        const seconds = Math.max(1, Math.ceil((Date.parse(result.retryAt) - Date.now()) / 1000));
        return errorResponse('Cost Explorer read recently', 429, { 'Retry-After': String(seconds) });
      } catch (error) {
        if (error instanceof DomainError) return errorResponse(error.message, error.statusCode);
        log({ event: 'COST_REFRESH_FAILED', correlationId: event.headers.correlationId, status: 'error', message: 'Could not read Cost Explorer', error });
        return errorResponse('Cost Explorer unavailable', 503);
      }
    }

    // todas as linhas de log de uma compra (correlationId)
    const traceMatch = event.method === 'GET' && event.path.match(/^\/trace\/([^/]+)$/);
    if (traceMatch) {
      // Ids só têm [\w.:-]: nada a decodificar, o que vier codificado é inválido
      const correlationId = traceMatch[1];
      if (!isTraceId(correlationId)) return errorResponse('Invalid correlationId', 400);
      try {
        return successResponse({ correlationId, logs: await logs.trace(correlationId) });
      } catch (error) {
        log({ event: 'TRACE_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: 'Could not read CloudWatch logs', error });
        return errorResponse('Trace unavailable', 503);
      }
    }

    if (event.method === 'GET' && event.path === '/dlq') {
      return dlqCall(event, 'list', async () => successResponse(await dlq.listMessages()));
    }
    const dlqAction = event.method === 'POST' && event.path.match(/^\/dlq\/([^/]+)\/(redrive|discard)$/);
    if (dlqAction) {
      const [, messageId, action] = dlqAction;
      return dlqCall(event, action, async () => {
        const entry = await (action === 'redrive' ? dlq.redrive(messageId) : dlq.discard(messageId));
        log({
          event: action === 'redrive' ? 'DLQ_REDRIVEN' : 'DLQ_DISCARDED',
          correlationId: event.headers.correlationId,
          status: 'info',
          message: `DLQ message ${messageId} ${action === 'redrive' ? 'redriven' : 'discarded'} (${entry.source}/${entry.detailType})`,
          data: { messageId, detailType: entry.detailType, productId: entry.detail?.productId }
        });
        return successResponse({ [action === 'redrive' ? 'redriven' : 'discarded']: messageId });
      });
    }

    // injeção de falhas (src/common/chaos.mjs): PUT e DELETE são de admin
    if (event.path === '/chaos' && ['GET', 'PUT', 'DELETE'].includes(event.method)) {
      return chaosCall(event, chaos);
    }

    return notFound(event);
  };
}

async function chaosCall(event, chaos) {
  try {
    if (event.method === 'GET') return successResponse(await chaos.get());
    if (event.method === 'DELETE') {
      const result = await chaos.clear();
      log({ event: 'CHAOS_CLEARED', correlationId: event.headers.correlationId, status: 'info', message: 'Chaos faults cleared' });
      return successResponse(result);
    }
    let body;
    try {
      body = JSON.parse(event.body || '');
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }
    const result = await chaos.put(body);
    log({
      event: 'CHAOS_CONFIGURED',
      correlationId: event.headers.correlationId,
      status: 'info',
      message: `Chaos configured: ${result.faults.length} fault(s) until ${result.expiresAt}`,
      data: { expiresAt: result.expiresAt, faults: result.faults }
    });
    return successResponse(result);
  } catch (error) {
    if (error instanceof DomainError) return errorResponse(error.message, error.statusCode);
    log({ event: 'CHAOS_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: `Chaos ${event.method} failed`, error });
    return errorResponse('Chaos config unavailable', 503);
  }
}

async function refreshCost(cost) {
  try {
    const result = await cost.refreshActual();
    log({
      event: result.refreshed ? 'COST_REFRESHED' : 'COST_REFRESH_SKIPPED',
      status: 'info',
      message: result.refreshed ? 'Cost Explorer read' : `Cost Explorer read recently, next at ${result.retryAt}`,
      data: result
    });
    return result;
  } catch (error) {
    log({ event: 'COST_REFRESH_FAILED', status: 'error', message: 'Could not read Cost Explorer', error });
    throw error;
  }
}

async function dlqCall(event, action, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DomainError) return errorResponse(error.message, error.statusCode);
    log({ event: 'DLQ_UNAVAILABLE', correlationId: event.headers.correlationId, status: 'error', message: `DLQ ${action} failed`, error });
    return errorResponse('DLQ unavailable', 503);
  }
}

function notFound(event) {
  return notFoundResponse(event.path, {
    message: `Endpoint ${event.method} ${event.path} not found`,
    available: AVAILABLE_ENDPOINTS
  });
}

export const handleAPIRequest = createAPIHandler();

// Handler referenciado pelo template SAM (com a métrica de memória, como os serviços)
export const handler = withRuntimeMetrics(handleAPIRequest);
