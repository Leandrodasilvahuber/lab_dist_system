import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { NodeHttpHandler } from '@smithy/node-http-handler';

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
 * Conexão keep-alive que o servidor fechou enquanto a Lambda estava congelada:
 * entre invocações o container não roda, o socket parece aberto no pool e a
 * próxima chamada falha na hora com `socket hang up` (ECONNRESET) ou EPIPE.
 * Com SDK_MAX_ATTEMPTS: 1 isso virava 503 (ex.: GET /sagas). Num socket
 * reaproveitado a requisição não chegou a ser processada (o servidor já tinha
 * fechado), então repetir uma vez num socket novo é seguro até em escrita; é a
 * receita da documentação do Node (`request.reusedSocket`). Falha em
 * milissegundos, sem pesar no orçamento de tempo das funções.
 */
const STALE_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE']);

// Marca no erro se a requisição usou um socket do pool (o NodeHttpHandler não
// expõe a requisição do Node). O listener entra antes do do SDK, que rejeita
// com o mesmo objeto de erro
export function markReusedSockets(agent) {
  if (agent.$marksReusedSockets) return agent;
  const addRequest = agent.addRequest;
  agent.addRequest = function (req, options) {
    addRequest.call(this, req, options);
    req.once('error', error => {
      if (req.reusedSocket) error.$reusedSocket = true;
    });
  };
  agent.$marksReusedSockets = true;
  return agent;
}

export function isStaleSocketError(error) {
  return Boolean(error?.$reusedSocket) && STALE_SOCKET_CODES.has(error.code);
}

function retryStaleSocket(handler) {
  const handle = handler.handle.bind(handler);
  handler.handle = async (request, options) => {
    try {
      return await handle(request, options);
    } catch (error) {
      if (!isStaleSocketError(error) || options?.abortSignal?.aborted) throw error;
      return handle(request, options);
    }
  };
  return handler;
}

// Mesmos agentes que o SDK criaria (keep-alive, 50 sockets), mas marcados
const defaultAgentOptions = { keepAlive: true, maxSockets: 50 };

/**
 * Opções do NodeHttpHandler: `handlerOptions` extras (ex.: `httpAgent` e
 * `httpsAgent` compartilhados entre clientes do mesmo serviço) mais os timeouts.
 * @param {object} [options]
 * @param {number} [options.requestTimeout]
 * @param {Record<string, any>} [options.handlerOptions]
 */
export function requestHandlerOptions({ requestTimeout = DEFAULT_TIMEOUTS.requestTimeout, handlerOptions } = {}) {
  const { httpAgent = new HttpAgent(defaultAgentOptions), httpsAgent = new HttpsAgent(defaultAgentOptions), ...rest } = handlerOptions || {};
  return {
    ...rest,
    httpAgent: markReusedSockets(httpAgent),
    httpsAgent: markReusedSockets(httpsAgent),
    connectionTimeout: DEFAULT_TIMEOUTS.connectionTimeout,
    requestTimeout,
    // throwOnRequestTimeout: sem ele as versões recentes do SDK só registram
    // um aviso e a chamada continua esperando
    throwOnRequestTimeout: true
  };
}

/**
 * `handlerOptions`: ver requestHandlerOptions.
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
    requestHandler: retryStaleSocket(new NodeHttpHandler(requestHandlerOptions({ requestTimeout, handlerOptions }))),
    ...(endpoint && { endpoint })
  };
}
