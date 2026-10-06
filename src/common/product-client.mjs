import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DependencyUnavailableError, NotFoundError, ValidationError } from './errors.mjs';
import { IS_LOCAL, awsClientConfig, isTransientAwsError, scaled } from './aws-client.mjs';
import { CircuitBreaker } from './circuit-breaker.mjs';
import { requireId } from './validation.mjs';

// Erros de negócio da Lambda de produtos que viram o erro equivalente aqui
const DOMAIN_ERRORS = { NotFound: NotFoundError, ValidationError };

// Teto da invocação (inclui um cold start da Lambda de produtos). Entra no
// orçamento de tempo da SagaOrchestratorFunction (Timeout no template.yaml).
// No LocalStack o cold start de uma Lambda em contêiner passa disso: o
// local-server e o e2e aumentam via PRODUCT_TIMEOUT_MS.
export const PRODUCT_TIMEOUT_MS = Number(process.env.PRODUCT_TIMEOUT_MS) || scaled(5000);

// No LocalStack a lentidão vem da máquina sobrecarregada, não de Products fora
// do ar: o breaker local tolera mais falhas e testa a volta mais cedo
const LOCAL_CIRCUIT = IS_LOCAL ? { failureThreshold: 10, resetTimeoutMs: 10000 } : {};

// Uma tentativa só: com o retry do SDK, dois timeouts seguidos (2 x 5s)
// estourariam o orçamento da Lambda antes do 503, e o circuit breaker nunca
// registraria a falha. Quem repete é o cliente (Retry-After) e o breaker.
const PRODUCT_MAX_ATTEMPTS = 1;

// Throttling da Lambda de produtos (concorrência esgotada: pico de compras; no
// LocalStack, a concorrência reservada de 2) é a exceção: a recusa é imediata,
// então algumas esperas curtas cabem no orçamento, e passam assim que outra
// consulta termina. Sem elas, 4 compras simultâneas no LocalStack respondiam
// 503 na largada. Esperas com jitter completo, até 0,2+0,4+0,8+1,6+1,6 = 4,6 s
// na AWS; no LocalStack escalam com TIMEOUT_SCALE (cada consulta sobe um
// contêiner e leva segundos para liberar a vaga)
export const THROTTLE_DELAYS_MS = [200, 400, 800, 1600, 1600].map(scaled);
const isThrottle = error => error?.name === 'TooManyRequestsException';

/**
 * Consulta o serviço de Products invocando a Lambda dele ({ action, input }),
 * em vez de ler a tabela de produtos, que pertence àquele serviço.
 *
 * Usado em duas chamadas síncronas entre serviços: a saga ao iniciar a
 * compra (preço e 404 imediato) e o Stock no ajuste que criaria o inventário
 * (StockSDK.adjustStock). Com Products fora do ar, a requisição responde 503
 * com Retry-After (DependencyUnavailableError) e, depois de falhas seguidas,
 * o circuit breaker responde na hora sem invocar.
 */
export class ProductClient {
  /**
   * @param {object} [options]
   * @param {string} [options.functionName]
   * @param {import('@aws-sdk/client-lambda').LambdaClient} [options.client]
   * @param {import('./circuit-breaker.mjs').CircuitBreaker} [options.breaker]
   * @param {(ms: number) => Promise<unknown>} [options.sleep]
   * @param {() => number} [options.random]
   */
  constructor({
    functionName = process.env.PRODUCT_FUNCTION_NAME,
    client,
    // O estado do breaker vive nesta instância: ela precisa durar entre
    // requisições (SagaService criado uma vez por módulo no controller).
    // Uma instância por requisição nunca acumularia falhas para abrir
    breaker = new CircuitBreaker({
      name: 'products',
      failureThreshold: Number(process.env.PRODUCT_CIRCUIT_FAILURE_THRESHOLD) || LOCAL_CIRCUIT.failureThreshold,
      resetTimeoutMs: Number(process.env.PRODUCT_CIRCUIT_RESET_MS) || LOCAL_CIRCUIT.resetTimeoutMs,
      // Só indisponibilidade abre o circuito; erro de configuração (500) não
      isFailure: error => error instanceof DependencyUnavailableError
    }),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    random = Math.random
  } = {}) {
    this.sleep = sleep;
    this.random = random;
    this.functionName = functionName;
    this.client = client || new LambdaClient(awsClientConfig('LAMBDA_ENDPOINT', {
      requestTimeout: PRODUCT_TIMEOUT_MS,
      maxAttempts: PRODUCT_MAX_ATTEMPTS
    }));
    this.breaker = breaker;
    // Consultas em andamento por produto (ver getProduct)
    this.inFlight = new Map();
  }

  /**
   * Compras simultâneas do mesmo produto esperam a mesma invocação em vez de
   * uma cada: sem isso, um pico num produto vira N invocações (N cold starts
   * no LocalStack, onde 10 simultâneos passaram de 30s cada). Não é cache: o
   * resultado vale só para quem pediu enquanto a consulta estava em andamento.
   * `correlationId` vai no input: as linhas da Lambda de produtos entram no
   * rastreio da compra (numa consulta compartilhada, vale o de quem chegou antes).
   * @param {string} productId
   * @param {object} [options]
   * @param {string} [options.correlationId]
   */
  async getProduct(productId, { correlationId } = {}) {
    if (!this.functionName) {
      throw new Error('PRODUCT_FUNCTION_NAME is not configured');
    }
    // Id inválido é 400 aqui, sem invocar: não chega ao Products nem ao breaker
    requireId(productId, 'productId');
    let pending = this.inFlight.get(productId);
    if (!pending) {
      pending = this.breaker.call(() => this.invoke(productId, correlationId))
        .finally(() => this.inFlight.delete(productId));
      this.inFlight.set(productId, pending);
    }
    // Cópia por chamador: ninguém altera o produto de outra compra
    return { ...(await pending) };
  }

  // Invoca a Lambda de produtos, repetindo só o throttling (THROTTLE_DELAYS_MS)
  async send(productId, correlationId) {
    const command = new InvokeCommand({
      FunctionName: this.functionName,
      Payload: JSON.stringify({ action: 'getProduct', input: { productId, ...(correlationId && { correlationId }) } })
    });
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.send(command);
      } catch (error) {
        if (!isThrottle(error) || attempt >= THROTTLE_DELAYS_MS.length) throw error;
        await this.sleep(this.random() * THROTTLE_DELAYS_MS[attempt]);
      }
    }
  }

  async invoke(productId, correlationId) {
    let response;
    try {
      response = await this.send(productId, correlationId);
    } catch (error) {
      // Permissão, parâmetro inválido, função inexistente
      // (PRODUCT_FUNCTION_NAME errado): erro de configuração (500), repetir não
      // adianta e não abre o circuito. Um deploy atualiza a função no lugar,
      // sem removê-la. Timeout, rede, throttling, 5xx e função ocupada
      // (ResourceConflictException durante uma atualização) são
      // indisponibilidade: 503
      if (isConfigurationError(error)) throw error;
      throw new DependencyUnavailableError('Product service unavailable', { cause: error });
    }

    const { Payload, FunctionError } = response;
    let result;
    try {
      result = Payload ? JSON.parse(Buffer.from(Payload).toString()) : null;
    } catch (error) {
      // Resposta malformada também é falha da dependência (503, conta no breaker)
      throw new DependencyUnavailableError('Product service unavailable', {
        cause: new Error(`Product service returned an invalid payload: ${error.message}`)
      });
    }

    if (FunctionError) {
      const DomainError = DOMAIN_ERRORS[result?.errorType];
      if (DomainError) throw new DomainError(result.errorMessage);
      throw new DependencyUnavailableError('Product service unavailable', {
        cause: new Error(`Product service failed: ${result?.errorMessage || FunctionError}`)
      });
    }
    return result;
  }
}

// 4xx da API do Lambda que passam sozinhos: outra operação em andamento na
// função (deploy) e SnapStart ainda preparando a versão
const TRANSIENT_LAMBDA_ERRORS = new Set(['ResourceConflictException', 'SnapStartNotReadyException']);

// Rejeição 4xx da API do Lambda que não é throttling nem estado passageiro
function isConfigurationError(error) {
  const status = error?.$metadata?.httpStatusCode;
  return status >= 400 && status < 500 && !isTransientAwsError(error) && !TRANSIENT_LAMBDA_ERRORS.has(error.name);
}
