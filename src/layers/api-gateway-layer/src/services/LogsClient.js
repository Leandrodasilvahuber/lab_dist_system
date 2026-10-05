import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { MAX_LOG_ENTRIES, MAX_TRACE_ENTRIES, isTraceId, parseLogLine, selectLogs, selectTrace } from '../../../../common/log-query.mjs';
import { awsClientConfig, DEFAULT_TIMEOUTS, QUERY_CLIENT_OPTIONS, QUERY_TIMEOUT_MS, scaled } from '../../../../common/aws-client.mjs';

// Páginas por consulta, somadas todas as janelas (ver listLogs)
const MAX_PAGES = 10;

// Primeira janela da aba Logs; cada janela seguinte, mais antiga, tem o dobro
const FIRST_WINDOW_MS = 60 * 60 * 1000;

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

  /**
   * O FilterLogEvents devolve as linhas da mais antiga para a mais nova, e a
   * leitura para em MAX_LOG_ENTRIES: numa consulta só sobre o período inteiro,
   * com mais linhas que isso a aba mostraria as mais antigas. Por isso a busca
   * anda para trás no tempo, em janelas que dobram (1 h, 2 h, 4 h...): cada
   * janela é lida até o fim, e as mais antigas só se faltarem linhas. Se o
   * orçamento acabar no meio de uma janela, a resposta sai com o que já foi lido.
   */
  async listLogs({ levels, hours }, now = Date.now()) {
    const filterPattern = `{ ${levels.map(level => `($.status = "${level}")`).join(' || ')} }`;
    const since = now - hours * 3600 * 1000;
    const budget = this.budget();
    const entries = [];
    let end = now;
    for (let span = FIRST_WINDOW_MS; end > since && entries.length < MAX_LOG_ENTRIES; span *= 2) {
      const start = Math.max(since, end - span);
      const { entries: found, complete } = await this.filter(filterPattern, start, end, budget);
      entries.push(...found);
      if (!complete) break;
      // startTime e endTime são inclusivos: a linha da borda não vem duas vezes
      end = start - 1;
    }
    return selectLogs(entries, { levels, hours }, now);
  }

  async trace(correlationId, now = Date.now()) {
    // O id entra no filter pattern: só caracteres de id (a rota já valida)
    if (!isTraceId(correlationId)) throw new Error('Invalid correlationId');
    // Aqui a ordem crescente é a desejada: o rastreio começa no início da compra
    const { entries } = await this.filter(`{ $.correlationId = "${correlationId}" }`, now - TRACE_HOURS * 3600 * 1000, now, this.budget(), MAX_TRACE_ENTRIES);
    return selectTrace(entries, correlationId);
  }

  // Prazo e páginas restantes, divididos pelas chamadas de uma mesma consulta
  budget() {
    return { deadline: this.clock() + FILTER_BUDGET_MS, pages: MAX_PAGES };
  }

  /**
   * Lê as páginas de [startTime, endTime] até acabarem, até `limit` linhas ou
   * até o orçamento acabar. `complete`: a janela foi lida até o fim.
   */
  async filter(filterPattern, startTime, endTime, budget, limit = Infinity) {
    if (!this.logGroupName) {
      throw new Error('LOG_GROUP_NAME is not configured');
    }

    const entries = [];
    let nextToken;
    while (entries.length < limit) {
      if (budget.pages <= 0) return { entries, complete: false };
      // A primeira página da consulta sai sempre; as outras só se couberem
      if (budget.pages < MAX_PAGES && this.clock() + PAGE_WORST_CASE_MS > budget.deadline) {
        return { entries, complete: false };
      }
      budget.pages -= 1;
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
      if (!nextToken) return { entries, complete: true };
    }
    return { entries, complete: false };
  }
}
