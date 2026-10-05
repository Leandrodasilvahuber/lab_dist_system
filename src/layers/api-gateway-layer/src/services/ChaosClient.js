import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { awsClientConfig } from '../../../../common/aws-client.mjs';
import { validateChaosConfig } from '../../../../common/chaos.mjs';

/**
 * Lê e grava a configuração de caos (src/common/chaos.mjs) no parâmetro do
 * SSM que as Lambdas dos serviços leem. GET /chaos devolve a config em vigor
 * (expirada conta como desligada); PUT valida e grava; DELETE grava a config
 * vazia (o parâmetro é recurso do template: apagá-lo deixaria a stack com drift).
 */
export class ChaosClient {
  constructor({
    parameterName = process.env.CHAOS_PARAM,
    enabled = process.env.CHAOS_ENABLED === 'true',
    client,
    now = Date.now
  } = {}) {
    this.parameterName = parameterName;
    this.enabled = enabled && Boolean(parameterName);
    this.client = client;
    this.now = now;
  }

  ssm() {
    this.client ||= new SSMClient(awsClientConfig('SSM_ENDPOINT', { maxAttempts: 1 }));
    return this.client;
  }

  async get() {
    if (!this.enabled) return { enabled: false, active: false, faults: [] };
    let config = { faults: [] };
    try {
      const { Parameter } = await this.ssm().send(new GetParameterCommand({ Name: this.parameterName }));
      config = JSON.parse(Parameter?.Value || '{}');
    } catch (error) {
      if (error?.name !== 'ParameterNotFound') throw error;
    }
    const active = Array.isArray(config.faults) && config.faults.length > 0 && Date.parse(config.expiresAt) > this.now();
    return { enabled: true, active, expiresAt: active ? config.expiresAt : null, faults: active ? config.faults : [] };
  }

  async put(input) {
    if (!this.enabled) return { enabled: false, active: false, faults: [] };
    const config = validateChaosConfig(input, { now: this.now });
    await this.write(config);
    return { enabled: true, active: config.faults.length > 0, ...config };
  }

  async clear() {
    if (!this.enabled) return { enabled: false, active: false, faults: [] };
    await this.write({ faults: [] });
    return { enabled: true, active: false, expiresAt: null, faults: [] };
  }

  write(config) {
    return this.ssm().send(new PutParameterCommand({
      Name: this.parameterName,
      Value: JSON.stringify(config),
      Type: 'String',
      Overwrite: true
    }));
  }
}
