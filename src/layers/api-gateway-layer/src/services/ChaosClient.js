import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { awsClientConfig } from '../../../../common/aws-client.mjs';
import { validateChaosConfig } from '../../../../common/chaos.mjs';
import * as database from '../../../../common/database.mjs';
import { ChaosLimitError } from '../../../../common/errors.mjs';
import { QUOTA_ID_PREFIX, limitFromEnv, quotaDay, quotaExpiresAt } from '../../../../common/daily-quota.mjs';

// Vezes por dia que o caos pode ser ligado (PUT /chaos, aberto a todos;
// DailyChaosLimit no template.yaml). Cada ativação dura no máximo
// CHAOS_MAX_MINUTES, então o limite também segura o tempo de caos (e o custo
// da latência injetada) por dia. Desligar não conta. 0 = sem limite
export const DEFAULT_DAILY_CHAOS_LIMIT = 20;
// Contador na tabela de sagas, com o prefixo comum dos contadores diários
const CHAOS_COUNTER_PREFIX = `${QUOTA_ID_PREFIX}chaos_`;

/**
 * Lê e grava a configuração de caos (src/common/chaos.mjs) no parâmetro do
 * SSM que as Lambdas dos serviços leem. GET /chaos devolve a config em vigor
 * (expirada conta como desligada); PUT valida e grava; DELETE grava a config
 * vazia (o parâmetro é recurso do template: apagá-lo deixaria a stack com drift).
 * Aberto a todos: ligar conta no limite diário (DEFAULT_DAILY_CHAOS_LIMIT).
 */
export class ChaosClient {
  /**
   * @param {object} [options]
   * @param {string} [options.parameterName]
   * @param {boolean} [options.enabled]
   * @param {number} [options.limit] ativações por dia (0 = sem limite)
   * @param {import('@aws-sdk/client-ssm').SSMClient} [options.client]
   * @param {typeof database} [options.db]
   * @param {() => number} [options.now]
   */
  constructor({
    parameterName = process.env.CHAOS_PARAM,
    enabled = process.env.CHAOS_ENABLED === 'true',
    limit = limitFromEnv(process.env.CHAOS_DAILY_LIMIT, DEFAULT_DAILY_CHAOS_LIMIT),
    client,
    db = database,
    now = Date.now
  } = {}) {
    this.parameterName = parameterName;
    this.enabled = enabled && Boolean(parameterName);
    this.limit = limit;
    this.client = client;
    this.db = db;
    this.now = now;
  }

  // Dia de cota atual: id do contador e quando ele zera
  window() {
    const { day, resetsAtMs } = quotaDay(this.now());
    return { id: `${CHAOS_COUNTER_PREFIX}${day}`, resetsAtMs };
  }

  // Limite do dia: { limit, used, remaining, resetsAt } (vazio sem limite)
  quota(used) {
    if (!this.limit) return {};
    const { resetsAtMs } = this.window();
    return { limit: this.limit, used, remaining: Math.max(0, this.limit - used), resetsAt: new Date(resetsAtMs).toISOString() };
  }

  async used() {
    if (!this.limit) return 0;
    const counter = await this.db.getItem('sagas', { id: this.window().id }, { consistentRead: true });
    return counter?.activations || 0;
  }

  // Soma 1 nas ativações do dia, só se ainda não chegou ao limite
  async count() {
    if (!this.limit) return 0;
    const { id, resetsAtMs } = this.window();
    try {
      const attributes = await this.db.updateItem('sagas', { id }, 'ADD activations :one SET expiresAt = :expiresAt',
        { ':one': 1, ':limit': this.limit, ':expiresAt': quotaExpiresAt(resetsAtMs) },
        { retry: false, conditionExpression: 'attribute_not_exists(activations) OR activations < :limit' });
      return attributes.activations;
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      throw new ChaosLimitError(this.limit, {
        resetsAt: new Date(resetsAtMs).toISOString(),
        retryAfterSeconds: Math.ceil((resetsAtMs - this.now()) / 1000)
      });
    }
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
    return {
      enabled: true,
      active,
      expiresAt: active ? config.expiresAt : null,
      faults: active ? config.faults : [],
      ...this.quota(await this.used())
    };
  }

  async put(input) {
    if (!this.enabled) return { enabled: false, active: false, faults: [] };
    const config = validateChaosConfig(input, { now: this.now });
    // Só ligar conta: uma config sem falhas equivale a desligar
    const used = config.faults.length ? await this.count() : await this.used();
    await this.write(config);
    return { enabled: true, active: config.faults.length > 0, ...config, ...this.quota(used) };
  }

  async clear() {
    if (!this.enabled) return { enabled: false, active: false, faults: [] };
    await this.write({ faults: [] });
    return { enabled: true, active: false, expiresAt: null, faults: [], ...this.quota(await this.used()) };
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
