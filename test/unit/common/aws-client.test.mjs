import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { DEFAULT_TIMEOUTS, QUERY_CLIENT_OPTIONS, TIMEOUT_SCALE, awsClientConfig, isLocalStack, timeoutScale } from '../../../src/common/aws-client.mjs';
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
  // As contas valem para a AWS: com AWS_ENDPOINT/TIMEOUT_SCALE no shell o
  // perfil local estaria ativo e os orçamentos não se aplicam
  it('roda com o perfil de produção', () => {
    assert.strictEqual(TIMEOUT_SCALE, 1, 'rode os testes sem AWS_ENDPOINT, LOCALSTACK_HOSTNAME e TIMEOUT_SCALE');
  });

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
    const { PRODUCT_TIMEOUT_MS } = await import('../../../src/common/product-client.mjs');
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

describe('timeoutScale (perfil local)', () => {
  it('na AWS (sem endpoint do LocalStack) mantém os valores de produção', () => {
    assert.strictEqual(timeoutScale({}), 1);
    // Variável padrão do SDK, pode existir na AWS: não liga o perfil local
    assert.strictEqual(timeoutScale({ AWS_ENDPOINT_URL: 'https://vpce.example' }), 1);
  });

  it('triplica os timeouts contra o LocalStack', () => {
    assert.strictEqual(timeoutScale({ AWS_ENDPOINT: 'http://localhost:4566' }), 3);
    assert.strictEqual(timeoutScale({ LOCALSTACK_HOSTNAME: 'localhost.localstack.cloud' }), 3);
  });

  it('TIMEOUT_SCALE sobrescreve a detecção (1 desliga o perfil local)', () => {
    assert.strictEqual(timeoutScale({ AWS_ENDPOINT: 'http://localhost:4566', TIMEOUT_SCALE: '1' }), 1);
    assert.strictEqual(timeoutScale({ TIMEOUT_SCALE: '2' }), 2);
  });

  it('isLocalStack não depende do TIMEOUT_SCALE (a fila do dashboard continua)', () => {
    assert.strictEqual(isLocalStack({ AWS_ENDPOINT: 'http://localhost:4566', TIMEOUT_SCALE: '1' }), true);
    assert.strictEqual(isLocalStack({ LOCALSTACK_HOSTNAME: 'localhost.localstack.cloud' }), true);
    assert.strictEqual(isLocalStack({ AWS_ENDPOINT_URL: 'https://vpce.example' }), false);
  });
});
