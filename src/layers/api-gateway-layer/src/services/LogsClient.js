import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { MAX_LOG_ENTRIES, MAX_TRACE_ENTRIES, isTraceId, parseLogLine, selectLogs, selectTrace } from '../../../../common/log-query.mjs';

const MAX_PAGES = 5;

// Rastreio olha todo o período de retenção do log group (RetentionInDays: 14)
export const TRACE_HOURS = 24 * 14;

/**
 * Lê o log group das Lambdas (ServicesLogGroup): linhas warn/error para a aba
 * Logs e todas as linhas de um correlationId para a aba Rastreio.
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
    const filterPattern = `{ ${levels.map(level => `($.status = "${level}")`).join(' || ')} }`;
    const entries = await this.filter(filterPattern, now - hours * 3600 * 1000, now, MAX_LOG_ENTRIES);
    return selectLogs(entries, { levels, hours }, now);
  }

  async trace(correlationId, now = Date.now()) {
    // O id entra no filter pattern: só caracteres de id (a rota já valida)
    if (!isTraceId(correlationId)) throw new Error('Invalid correlationId');
    const entries = await this.filter(`{ $.correlationId = "${correlationId}" }`, now - TRACE_HOURS * 3600 * 1000, now, MAX_TRACE_ENTRIES);
    return selectTrace(entries, correlationId);
  }

  async filter(filterPattern, startTime, endTime, limit) {
    if (!this.logGroupName) {
      throw new Error('LOG_GROUP_NAME is not configured');
    }

    const entries = [];
    let nextToken;
    for (let page = 0; page < MAX_PAGES && entries.length < limit; page++) {
      const response = await this.client.send(new FilterLogEventsCommand({
        logGroupName: this.logGroupName,
        filterPattern,
        startTime,
        endTime,
        nextToken
      }));
      for (const { message } of response.events || []) {
        const entry = parseLogLine(message?.trim());
        if (entry) entries.push(entry);
      }
      nextToken = response.nextToken;
      if (!nextToken) break;
    }
    return entries;
  }
}
