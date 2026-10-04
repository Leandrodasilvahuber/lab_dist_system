import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { awsClientConfig } from '../../../../common/aws-client.mjs';

// ALARM primeiro, depois sem dados, depois OK
const STATE_ORDER = { ALARM: 0, INSUFFICIENT_DATA: 1, OK: 2 };

/**
 * Lê os alarmes do CloudWatch criados pelo template.yaml (nome começando
 * com ALARM_PREFIX) para a aba de monitoramento do dashboard.
 */
export class AlarmsClient {
  constructor({ prefix = process.env.ALARM_PREFIX, client } = {}) {
    this.prefix = prefix;
    this.client = client || new CloudWatchClient(awsClientConfig('CLOUDWATCH_ENDPOINT'));
  }

  async listAlarms() {
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
