import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { DEFAULT_TIMEOUTS, QUERY_CLIENT_OPTIONS, awsClientConfig } from '../../../src/common/aws-client.mjs';
import { MAX_SOCKETS, SCAN_TIMEOUT_MS } from '../../../src/common/database.mjs';
import { MAX_PAGE_SIZE } from '../../../src/common/pagination.mjs';

const template = fs.readFileSync(new URL('../../../template.yaml', import.meta.url), 'utf8');

// Timeout de uma função do template (ou o de Globals, se ela não define)
function functionTimeoutMs(name) {
  const block = template.split(new RegExp(`\\n {2}${name}:\\n`))[1]?.split(/\n {2}\S/)[0] ?? '';
  const own = block.match(/\n\s+Timeout: (\d+)/);
  const global = template.match(/Globals:[\s\S]*?\n\s+Timeout: (\d+)/);
  return Number((own || global)[1]) * 1000;
}

// Pior caso de uma chamada do SDK: conexão + resposta, vezes as tentativas
const callMs = (requestTimeout, maxAttempts) => maxAttempts * (DEFAULT_TIMEOUTS.connectionTimeout + requestTimeout);

describe('orçamento de tempo dos clientes da AWS (template.yaml)', () => {
  it('uma consulta de observabilidade termina antes do timeout da GatewayFunction', () => {
    assert.ok(callMs(QUERY_CLIENT_OPTIONS.requestTimeout, QUERY_CLIENT_OPTIONS.maxAttempts) < functionTimeoutMs('GatewayFunction'));
  });

  it('o pior caso do GET /stock (Scan + reservas de uma página em paralelo) cabe no timeout da StockFunction', () => {
    // Scan com uma tentativa, depois as consultas de reservas (retry: false)
    const worst = callMs(SCAN_TIMEOUT_MS, 1) + callMs(DEFAULT_TIMEOUTS.requestTimeout, 1);
    assert.ok(worst < functionTimeoutMs('StockFunction') - 1000, `pior caso ${worst}ms`);
    // Uma página inteira sai numa leva só, sem esperar socket
    assert.ok(MAX_SOCKETS >= MAX_PAGE_SIZE);
  });

  it('o pior caso do POST /saga/execute cabe no timeout da SagaOrchestratorFunction', async () => {
    // A saga usa SDK_MAX_ATTEMPTS: 1 (template.yaml)
    assert.match(template, /SERVICE_TYPE: saga-orchestrator\n\s+SDK_MAX_ATTEMPTS: '1'/);
    // Importado depois de fixar o default: o env do teste não pode mudar a conta
    delete process.env.PRODUCT_TIMEOUT_MS;
    const { PRODUCT_TIMEOUT_MS } = await import('../../../src/ecommerce/saga-orchestrator/src/services/ProductClient.js');
    const sdk = callMs(DEFAULT_TIMEOUTS.requestTimeout, 1);
    const products = callMs(PRODUCT_TIMEOUT_MS, 1);
    // getItem + Products + putItem + StartExecution + gravação do resultado
    const newSaga = sdk + products + sdk + sdk + sdk;
    // getItem + updateItem + StartExecution + novo executionName + StartExecution + gravação do resultado
    const restart = 6 * sdk;
    assert.ok(Math.max(newSaga, restart) < functionTimeoutMs('SagaOrchestratorFunction'),
      `pior caso ${Math.max(newSaga, restart)}ms`);
  });
});

describe('awsClientConfig', () => {
  it('repassa as opções extras do handler sem perder os timeouts', () => {
    const httpAgent = {};
    const { requestHandler } = awsClientConfig(undefined, { handlerOptions: { httpAgent, requestTimeout: 1 } });
    assert.strictEqual(requestHandler.httpAgent, httpAgent);
    assert.strictEqual(requestHandler.requestTimeout, DEFAULT_TIMEOUTS.requestTimeout);
    assert.strictEqual(requestHandler.throwOnRequestTimeout, true);
  });
});
