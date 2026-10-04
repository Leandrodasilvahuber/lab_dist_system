import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { MAX_LOG_ENTRIES, MAX_TRACE_ENTRIES, isTraceId, parseLogLine, selectLogs, selectTrace } from '../../../../common/log-query.mjs';
import { awsClientConfig, DEFAULT_TIMEOUTS, QUERY_CLIENT_OPTIONS, QUERY_TIMEOUT_MS, scaled } from '../../../../common/aws-client.mjs';

const MAX_PAGES = 5;

// Orçamento das páginas de uma consulta: timeout da GatewayFunction (15s)
// menos 1s para montar a resposta. Cada página pode levar até 1s de conexão + QUERY_TIMEOUT_MS, então só
// pede a próxima se ela ainda couber. Sem isso a Lambda estouraria e o API
// Gateway responderia sem Retry-After; com ele a resposta sai com as linhas
// já lidas (parte das linhas fica de fora só em períodos muito volumosos).
// Escala com a conexão (TIMEOUT_SCALE): no local-server não há timeout de Lambda
export const FILTER_BUDGET_MS = scaled(14000);
const PAGE_WORST_CASE_MS = DEFAULT_TIMEOUTS.connectionTimeout + QUERY_TIMEOUT_MS;

// Rastreio olha todo o período de retenção do log group (RetentionInDays: 14)
export const TRACE_HOURS = 24 * 14;

/**
 * Lê o log group das Lambdas (ServicesLogGroup): linhas warn/error para a aba
 * Logs e todas as linhas de um correlationId para a aba Rastreio.
 */
export class LogsClient {
  constructor({ logGroupName = process.env.LOG_GROUP_NAME, client, clock = Date.now } = {}) {
    this.logGroupName = logGroupName;
    this.clock = clock;
    this.client = client || new CloudWatchLogsClient(awsClientConfig('CLOUDWATCH_LOGS_ENDPOINT', QUERY_CLIENT_OPTIONS));
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
    const deadline = this.clock() + FILTER_BUDGET_MS;
    for (let page = 0; page < MAX_PAGES && entries.length < limit; page++) {
      if (page > 0 && this.clock() + PAGE_WORST_CASE_MS > deadline) break;
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
