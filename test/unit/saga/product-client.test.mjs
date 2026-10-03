import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ProductClient } from '../../../src/ecommerce/saga-orchestrator/src/services/ProductClient.js';
import { NotFoundError } from '../../../src/common/errors.mjs';

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

  it('erro NotFound da Lambda vira NotFoundError (404 imediato na saga)', async () => {
    const client = fakeLambda({ FunctionError: 'Unhandled', Payload: { errorType: 'NotFound', errorMessage: 'Product not found' } });
    await assert.rejects(new ProductClient({ functionName: 'f', client }).getProduct('x'), NotFoundError);
  });

  it('outros erros da Lambda não viram erro de negócio', async () => {
    const client = fakeLambda({ FunctionError: 'Unhandled', Payload: { errorType: 'Error', errorMessage: 'boom' } });
    await assert.rejects(
      new ProductClient({ functionName: 'f', client }).getProduct('x'),
      error => !(error instanceof NotFoundError) && /boom/.test(error.message)
    );
  });
});
