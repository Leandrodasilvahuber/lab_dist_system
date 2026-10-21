/**
 * Configuração comum dos clientes do AWS SDK.
 *
 * Sem timeout próprio, uma chamada lenta (DynamoDB, Lambda, EventBridge) só é
 * cortada pelo timeout da Lambda, e consome sozinha uma tentativa inteira do
 * Step Functions. Com `requestTimeout` a chamada falha rápido e quem repete é
 * a camada de cima.
 *
 * `maxAttempts: 2`: o SDK repete uma vez (com backoff e jitter). Os passos da
 * saga já são repetidos pelo Step Functions: com o padrão do SDK (3) os
 * retries se multiplicam e pioram justamente o throttling que querem contornar.
 * `SDK_MAX_ATTEMPTS` sobrescreve o padrão por função: a SagaOrchestratorFunction
 * usa 1 para que o pior caso do POST /saga/execute caiba no timeout dela
 * (ver template.yaml).
 *
 * `endpointEnv`: variável com o endpoint do serviço (LocalStack); sem ela e
 * sem AWS_ENDPOINT o SDK usa o endpoint padrão da região.
 */

/**
 * Perfil local: contra o LocalStack o gargalo é a CPU da máquina, não o
 * timeout da Lambda, e os timeouts da AWS viram 503 em cascata sob carga.
 * Detecta o LocalStack por `AWS_ENDPOINT` (local-server e e2e) ou
 * `LOCALSTACK_HOSTNAME` (injetada nas Lambdas que ele executa). Não usa
 * `AWS_ENDPOINT_URL`: é variável padrão do SDK e pode existir na AWS (VPC
 * endpoint). Na AWS nenhuma delas existe e a escala é 1 (valores de produção).
 * `TIMEOUT_SCALE` sobrescreve (1 desliga o perfil local).
 */
export const isLocalStack = (env = process.env) => Boolean(env.AWS_ENDPOINT || env.LOCALSTACK_HOSTNAME);
export function timeoutScale(env = process.env) {
  return Number(env.TIMEOUT_SCALE) || (isLocalStack(env) ? 3 : 1);
}
export const TIMEOUT_SCALE = timeoutScale();
export const IS_LOCAL = TIMEOUT_SCALE !== 1;
export const scaled = ms => ms * TIMEOUT_SCALE;

export const DEFAULT_TIMEOUTS = { connectionTimeout: scaled(1000), requestTimeout: scaled(3000) };

// Consultas de observabilidade (logs, métricas, histórico de execuções) leem
// muito mais dados por chamada; o teto é o timeout da GatewayFunction (15s).
// Uma tentativa só: com o retry do SDK, duas chamadas lentas (2 x (1s + 10s))
// estourariam a Lambda antes de ela responder 503 (apiRoutes). Quem repete é
// o dashboard, no próximo refresh. Fora do perfil local: já é folgado, e
// escalado não caberia nem uma página no orçamento do LogsClient
export const QUERY_TIMEOUT_MS = 10000;
export const QUERY_CLIENT_OPTIONS = { requestTimeout: QUERY_TIMEOUT_MS, maxAttempts: 1 };

// Falhas que passam sozinhas (throttling, timeout, erro 5xx do serviço, conexão
// caída): o cliente deve repetir mais tarde, então viram 503, não 500. Pesa
// mais onde o SDK não repete (SDK_MAX_ATTEMPTS: 1 na SagaOrchestratorFunction).
const TRANSIENT_ERROR_NAMES = new Set([
  'ThrottlingException', 'Throttling', 'TooManyRequestsException', 'ProvisionedThroughputExceededException',
  'RequestLimitExceeded', 'TimeoutError', 'RequestTimeout', 'RequestTimeoutException'
]);
const TRANSIENT_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);

export function isTransientAwsError(error) {
  return Boolean(error?.$retryable) ||
    TRANSIENT_ERROR_NAMES.has(error?.name) ||
    TRANSIENT_ERROR_CODES.has(error?.code) ||
    error?.$metadata?.httpStatusCode >= 500;
}

function defaultMaxAttempts() {
  return Number(process.env.SDK_MAX_ATTEMPTS) || 2;
}

/**
 * `handlerOptions`: opções extras do NodeHttpHandler (ex.: `httpAgent` e
 * `httpsAgent` compartilhados entre clientes do mesmo serviço).
 * @param {string} endpointEnv
 * @param {object} [options]
 * @param {number} [options.requestTimeout]
 * @param {number} [options.maxAttempts]
 * @param {Record<string, any>} [options.handlerOptions]
 */
export function awsClientConfig(endpointEnv, { requestTimeout = DEFAULT_TIMEOUTS.requestTimeout, maxAttempts = defaultMaxAttempts(), handlerOptions } = {}) {
  const endpoint = (endpointEnv && process.env[endpointEnv]) || process.env.AWS_ENDPOINT;
  return {
    region: process.env.AWS_REGION || 'us-east-1',
    maxAttempts,
    // throwOnRequestTimeout: sem ele as versões recentes do SDK só registram
    // um aviso e a chamada continua esperando
    requestHandler: { ...handlerOptions, connectionTimeout: DEFAULT_TIMEOUTS.connectionTimeout, requestTimeout, throwOnRequestTimeout: true },
    ...(endpoint && { endpoint })
  };
}
