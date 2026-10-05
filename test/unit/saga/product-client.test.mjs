import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ProductClient } from '../../../src/ecommerce/saga-orchestrator/src/services/ProductClient.js';
import { DependencyUnavailableError, NotFoundError } from '../../../src/common/errors.mjs';
import { CircuitBreaker } from '../../../src/common/circuit-breaker.mjs';

// Imita o LambdaClient: devolve o Payload como bytes, igual ao SDK
function fakeLambda(response) {
  return {
    sent: [],
    async send(command) {
      this.sent.push(command.input);
      return { ...response, Payload: Buffer.from(JSON.stringify(response.Payload)) };
    }
  };
}

describe('ProductClient', () => {
  it('invoca a Lambda de produtos com { action, input } e devolve o produto', async () => {
    const client = fakeLambda({ Payload: { id: 'apple', price: 5 } });
    const products = new ProductClient({ functionName: 'ProductFunction', client });

    assert.deepStrictEqual(await products.getProduct('apple'), { id: 'apple', price: 5 });
    assert.strictEqual(client.sent[0].FunctionName, 'ProductFunction');
    assert.deepStrictEqual(JSON.parse(client.sent[0].Payload), { action: 'getProduct', input: { productId: 'apple' } });
  });

  // Pico de compras do mesmo produto: uma invocação, não uma por compra
  it('consultas simultâneas do mesmo produto compartilham uma invocação', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const client = {
      sent: [],
      async send(command) {
        this.sent.push(JSON.parse(command.input.Payload).input.productId);
        await gate;
        return { Payload: Buffer.from(JSON.stringify({ id: 'apple', price: 5 })) };
      }
    };
    const products = new ProductClient({ functionName: 'f', client });

    const calls = [products.getProduct('apple'), products.getProduct('apple'), products.getProduct('banana')];
    release();
    const [a, b] = await Promise.all(calls);
    assert.deepStrictEqual(client.sent, ['apple', 'banana']);
    assert.deepStrictEqual(a, b);
    // Cada chamador recebe a sua cópia
    assert.notStrictEqual(a, b);

    // Terminada a consulta, a próxima invoca de novo (não é cache)
    await products.getProduct('apple');
    assert.deepStrictEqual(client.sent, ['apple', 'banana', 'apple']);
  });

  it('a falha também é compartilhada e não fica guardada', async () => {
    let fail = true;
    const client = { calls: 0, async send() {
      this.calls++;
      if (fail) throw Object.assign(new Error('socket timeout'), { name: 'TimeoutError' });
      return { Payload: Buffer.from(JSON.stringify({ id: 'x' })) };
    } };
    const products = new ProductClient({ functionName: 'f', client });
    const results = await Promise.allSettled([products.getProduct('x'), products.getProduct('x')]);
    assert.ok(results.every(r => r.status === 'rejected' && r.reason instanceof DependencyUnavailableError));
    assert.strictEqual(client.calls, 1);
    fail = false;
    assert.deepStrictEqual(await products.getProduct('x'), { id: 'x' });
  });

  it('uma tentativa só por invocação: o retry do SDK estouraria o timeout da Lambda antes do 503', async () => {
    const products = new ProductClient({ functionName: 'f' });
    assert.strictEqual(await products.client.config.maxAttempts(), 1);
  });

  it('erro NotFound da Lambda vira NotFoundError (404 imediato na saga)', async () => {
    const client = fakeLambda({ FunctionError: 'Unhandled', Payload: { errorType: 'NotFound', errorMessage: 'Product not found' } });
    await assert.rejects(new ProductClient({ functionName: 'f', client }).getProduct('x'), NotFoundError);
  });

  it('outros erros da Lambda viram 503 (dependência indisponível), não erro de negócio', async () => {
    const client = fakeLambda({ FunctionError: 'Unhandled', Payload: { errorType: 'Error', errorMessage: 'boom' } });
    await assert.rejects(
      new ProductClient({ functionName: 'f', client }).getProduct('x'),
      error => error instanceof DependencyUnavailableError && /boom/.test(error.cause.message)
    );
  });

  it('timeout/erro de rede da invocação vira 503', async () => {
    const client = { async send() { throw Object.assign(new Error('socket timeout'), { name: 'TimeoutError' }); } };
    await assert.rejects(new ProductClient({ functionName: 'f', client }).getProduct('x'), DependencyUnavailableError);
  });

  it('erro de configuração (permissão) responde 500 e não abre o circuito', async () => {
    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
    const client = { async send() { throw denied; } };
    // Breaker padrão do ProductClient (abre com 5 falhas)
    const products = new ProductClient({ functionName: 'f', client });
    for (let i = 0; i < 6; i++) await assert.rejects(products.getProduct('x'), error => error === denied);
    assert.strictEqual(products.breaker.state, 'closed');
  });

  it('função inexistente (PRODUCT_FUNCTION_NAME errado) é erro de configuração: 500, sem abrir o circuito', async () => {
    const missing = Object.assign(new Error('Function not found'), { name: 'ResourceNotFoundException', $metadata: { httpStatusCode: 404 } });
    const client = { async send() { throw missing; } };
    const products = new ProductClient({ functionName: 'f', client });
    for (let i = 0; i < 6; i++) await assert.rejects(products.getProduct('x'), error => error === missing);
    assert.strictEqual(products.breaker.state, 'closed');
  });

  it('função ocupada por um deploy (ResourceConflictException, 409) é indisponibilidade: 503', async () => {
    const busy = Object.assign(new Error('An update is in progress'), { name: 'ResourceConflictException', $metadata: { httpStatusCode: 409 } });
    const client = { async send() { throw busy; } };
    await assert.rejects(
      new ProductClient({ functionName: 'f', client }).getProduct('x'),
      error => error instanceof DependencyUnavailableError && error.cause === busy
    );
  });

  it('throttling da API do Lambda (429) é indisponibilidade: 503', async () => {
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'TooManyRequestsException', $metadata: { httpStatusCode: 429 } });
    const client = { async send() { throw throttled; } };
    await assert.rejects(new ProductClient({ functionName: 'f', client }).getProduct('x'), DependencyUnavailableError);
  });

  it('depois de falhas seguidas o circuito abre e responde sem invocar a Lambda', async () => {
    let calls = 0;
    const client = { async send() { calls += 1; throw new Error('down'); } };
    const breaker = new CircuitBreaker({ name: 'products', failureThreshold: 2, resetTimeoutMs: 30000 });
    const products = new ProductClient({ functionName: 'f', client, breaker });

    await assert.rejects(products.getProduct('x'), DependencyUnavailableError);
    await assert.rejects(products.getProduct('x'), DependencyUnavailableError);
    await assert.rejects(products.getProduct('x'), /circuit open/);
    assert.strictEqual(calls, 2);
  });

  it('NotFound não conta como falha para o circuito', async () => {
    const client = fakeLambda({ FunctionError: 'Unhandled', Payload: { errorType: 'NotFound', errorMessage: 'Product not found' } });
    const breaker = new CircuitBreaker({ name: 'products', failureThreshold: 1 });
    const products = new ProductClient({ functionName: 'f', client, breaker });
    await assert.rejects(products.getProduct('x'), NotFoundError);
    await assert.rejects(products.getProduct('x'), NotFoundError);
    assert.strictEqual(breaker.state, 'closed');
  });
});
