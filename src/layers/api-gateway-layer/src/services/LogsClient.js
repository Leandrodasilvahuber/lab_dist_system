import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { MAX_LOG_ENTRIES, parseLogLine, selectLogs } from '../../../../common/log-query.mjs';

const MAX_PAGES = 5;

/**
 * Lê as linhas warn/error do log group das Lambdas (ServicesLogGroup) para a
 * aba Logs do dashboard.
 */
export class LogsClient {
  constructor({ logGroupName = process.env.LOG_GROUP_NAME, client } = {}) {
    this.logGroupName = logGroupName;
    const endpoint = process.env.CLOUDWATCH_LOGS_ENDPOINT || process.env.AWS_ENDPOINT;
    this.client = client || new CloudWatchLogsClient({
      region: process.env.AWS_REGION || 'us-east-1',
      ...(endpoint && { endpoint })
    });
  }

  async listLogs({ levels, hours }, now = Date.now()) {
    if (!this.logGroupName) {
      throw new Error('LOG_GROUP_NAME is not configured');
    }

    const filterPattern = `{ ${levels.map(level => `($.status = "${level}")`).join(' || ')} }`;
    const entries = [];
    let nextToken;
    for (let page = 0; page < MAX_PAGES && entries.length < MAX_LOG_ENTRIES; page++) {
      const response = await this.client.send(new FilterLogEventsCommand({
        logGroupName: this.logGroupName,
        filterPattern,
        startTime: now - hours * 3600 * 1000,
        endTime: now,
        nextToken
      }));
      for (const { message } of response.events || []) {
        const entry = parseLogLine(message?.trim());
        if (entry) entries.push(entry);
      }
      nextToken = response.nextToken;
      if (!nextToken) break;
    }
    return selectLogs(entries, { levels, hours }, now);
  }
}
