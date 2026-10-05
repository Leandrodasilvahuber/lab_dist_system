import { log } from './logger.mjs';
import { IS_LOCAL } from './aws-client.mjs';

// Nome da série: a Lambda na AWS e no LocalStack (local-*); no local-server os
// handlers dividem o mesmo processo, então a série é a do processo inteiro
export const runtimeFunctionName = () => process.env.AWS_LAMBDA_FUNCTION_NAME || 'local-server';

const MB = 1024 * 1024;

/**
 * Métricas de runtime por invocação, via EMF (namespace Ecommerce/<env>):
 *  - MemoryUsedMB: RSS do processo ao fim da invocação. Aproxima o
 *    "Max Memory Used" da linha REPORT (que é o pico), sem Logs Insights.
 *  - InvocationDurationMs: só no perfil local, onde não existe AWS/Lambda
 *    Duration para a estimativa de custo; na AWS ela é grátis e uma série
 *    custom a mais por função custaria US$ 0,30/mês.
 *
 * A linha sai como debug: abaixo do LOG_LEVEL o logger grava só o bloco
 * `_aws`, sem status, e a aba Logs não a mostra.
 */
export function withRuntimeMetrics(handler, { functionName = runtimeFunctionName, local = IS_LOCAL } = {}) {
  return async function instrumented(...args) {
    const started = Date.now();
    try {
      return await handler(...args);
    } finally {
      const metrics = { MemoryUsedMB: { value: Math.round(process.memoryUsage().rss / MB * 10) / 10, unit: 'Megabytes' } };
      if (local) metrics.InvocationDurationMs = { value: Date.now() - started, unit: 'Milliseconds' };
      log({
        event: 'RUNTIME_METRICS',
        status: 'debug',
        metrics: { metrics, dimensions: { FunctionName: functionName() }, dimensionSets: [['FunctionName']] }
      });
    }
  };
}
