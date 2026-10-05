import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { awsClientConfig } from '../../../../common/aws-client.mjs';

// ALARM primeiro, depois sem dados, depois OK
const STATE_ORDER = { ALARM: 0, INSUFFICIENT_DATA: 1, OK: 2 };

// DescribeAlarms tem cota baixa por conta e a rota é pública (o dashboard
// consulta a cada 30 s por aba): as abas dividem a mesma leitura por este tempo
export const ALARMS_CACHE_TTL_MS = 20 * 1000;

/**
 * Lê os alarmes do CloudWatch criados pelo template.yaml (nome começando
 * com ALARM_PREFIX) para a aba de monitoramento do dashboard.
 */
export class AlarmsClient {
  constructor({ prefix = process.env.ALARM_PREFIX, client, cacheTtlMs = ALARMS_CACHE_TTL_MS, now = Date.now } = {}) {
    this.prefix = prefix;
    this.client = client || new CloudWatchClient(awsClientConfig('CLOUDWATCH_ENDPOINT'));
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cached = null;
  }

  // Mesma ideia do SagaMetricsClient: guarda a promessa, falha não fica no cache
  listAlarms() {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.value;
    const value = this.readAlarms();
    this.cached = { value, expiresAt: this.now() + this.cacheTtlMs };
    value.catch(() => { if (this.cached?.value === value) this.cached = null; });
    return value;
  }

  async readAlarms() {
    const { MetricAlarms = [], CompositeAlarms = [] } = await this.client.send(new DescribeAlarmsCommand({
      ...(this.prefix && { AlarmNamePrefix: this.prefix }),
      MaxRecords: 100
    }));

    return [...MetricAlarms, ...CompositeAlarms]
      .map(alarm => ({
        name: alarm.AlarmName,
        description: alarm.AlarmDescription || null,
        state: alarm.StateValue,
        reason: alarm.StateReason || null,
        updatedAt: alarm.StateUpdatedTimestamp ? new Date(alarm.StateUpdatedTimestamp).toISOString() : null
      }))
      .sort((a, b) => (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3) || a.name.localeCompare(b.name));
  }
}
