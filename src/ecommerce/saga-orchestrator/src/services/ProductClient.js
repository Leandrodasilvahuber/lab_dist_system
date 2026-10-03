import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { NotFoundError, ValidationError } from '../../../../common/errors.mjs';

// Erros de negócio da Lambda de produtos que viram o erro equivalente aqui
const DOMAIN_ERRORS = { NotFound: NotFoundError, ValidationError };

/**
 * Consulta o serviço de Products invocando a Lambda dele ({ action, input }),
 * em vez de ler a tabela de produtos, que pertence àquele serviço.
 */
export class ProductClient {
  constructor({
    functionName = process.env.PRODUCT_FUNCTION_NAME,
    client
  } = {}) {
    this.functionName = functionName;
    const endpoint = process.env.LAMBDA_ENDPOINT || process.env.AWS_ENDPOINT;
    this.client = client || new LambdaClient({
      region: process.env.AWS_REGION || 'us-east-1',
      ...(endpoint && { endpoint })
    });
  }

  async getProduct(productId) {
    if (!this.functionName) {
      throw new Error('PRODUCT_FUNCTION_NAME is not configured');
    }

    const { Payload, FunctionError } = await this.client.send(new InvokeCommand({
      FunctionName: this.functionName,
      Payload: JSON.stringify({ action: 'getProduct', input: { productId } })
    }));
    const result = Payload ? JSON.parse(Buffer.from(Payload).toString()) : null;

    if (FunctionError) {
      const DomainError = DOMAIN_ERRORS[result?.errorType];
      if (DomainError) throw new DomainError(result.errorMessage);
      throw new Error(`Product service failed: ${result?.errorMessage || FunctionError}`);
    }
    return result;
  }
}
