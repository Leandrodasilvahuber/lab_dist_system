import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer';
import { metricNamespace } from '../../../../common/emf.mjs';
import { awsClientConfig, IS_LOCAL, QUERY_CLIENT_OPTIONS } from '../../../../common/aws-client.mjs';
import { CloudWatchMetricsClient } from './CloudWatchMetricsClient.js';
import { functionMemoryMb } from './MemoryMetricsClient.js';
import { parseHours } from '../../../../common/validation.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_S = DAY_MS / 1000;

// Estimativa muda pouco de um minuto para o outro e lê várias métricas
export const COST_ESTIMATE_CACHE_TTL_MS = 5 * 60 * 1000;
// Cada chamada ao Cost Explorer custa US$ 0,01 e os dados dele atualizam
// poucas vezes por dia: uma leitura a cada 6 h. O cache é do container da
// Lambda, então cada container novo paga a 1ª leitura (2 chamadas, US$ 0,02);
// a rota é só de admin e o throttling dela (5 req/s) limita quantos sobem
export const COST_ACTUAL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// Janela fixa do Cost Explorer: qualquer período da aba sai da mesma leitura
const ACTUAL_WINDOW_DAYS = 90;

/**
 * Preços de referência (us-east-1, arm64, sem free tier). A estimativa
 * serve para ver a ordem de grandeza e o que pesa; o valor cobrado é o do
 * Cost Explorer. Confira https://aws.amazon.com/pricing antes de escalar.
 */
export const PRICES = {
  lambdaGbSecondArm: 0.0000133334,
  lambdaRequest: 0.20 / 1e6,
  stepFunctionsTransition: 0.025 / 1000,
  httpApiRequest: 1.00 / 1e6,
  dynamoReadUnit: 0.125 / 1e6,
  dynamoWriteUnit: 0.625 / 1e6
};

// Transições de uma compra sem falha (Task + Record de cada passo, MarkCompleted e
// Succeed: saga-workflow.asl.json). Compensações têm mais; é uma estimativa
export const TRANSITIONS_PER_SAGA = 12;
// Local: cada Lambda local-* atende um Task da saga, seguido do Record no DynamoDB
const TRANSITIONS_PER_LOCAL_STEP = 2;

// Nomes iguais ao SERVICE do Cost Explorer, para comparar estimado × real
export const SERVICES = {
  lambda: 'AWS Lambda',
  stepFunctions: 'AWS Step Functions',
  apiGateway: 'Amazon API Gateway',
  dynamodb: 'Amazon DynamoDB'
};

const TABLE_ENV = ['PRODUCTS_TABLE', 'ORDERS_TABLE', 'PAYMENTS_TABLE', 'STOCK_RESERVATIONS_TABLE', 'INVENTORY_TABLE', 'SAGAS_TABLE'];

// Períodos da aba Recursos. Fixos porque a rota é pública e o `days` é a chave
// do cache da estimativa (GetMetricData é cobrado por métrica): trocar o days
// a cada requisição furaria o cache, como em parseHours
export const COST_DAYS = [7, 14, 30, ACTUAL_WINDOW_DAYS];

export function parseCostQuery(query = {}) {
  return { days: parseHours(query.days, { allowed: COST_DAYS, fallback: 14 }) };
}

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const round = v => Math.round(v * 1e6) / 1e6;
const sum = values => values.reduce((a, b) => a + b, 0);

/**
 * Custo para a aba Recursos:
 *  - estimated: métricas × PRICES, por serviço e por dia, nos dois ambientes.
 *    AWS: AWS/Lambda, AWS/States, AWS/ApiGateway e AWS/DynamoDB (métricas
 *    grátis). Local: InvocationDurationMs (runtime-metrics.mjs), já que o
 *    LocalStack não publica as métricas dos serviços; DynamoDB fica de fora.
 *  - actual/forecast: Cost Explorer, só na AWS (o LocalStack não tem). É o
 *    custo da conta inteira, não só desta stack.
 */
export class CostClient {
  constructor({
    namespace = metricNamespace(),
    cloudwatch,
    costExplorer,
    local = IS_LOCAL,
    env = process.env,
    now = Date.now,
    cacheTtlMs = COST_ESTIMATE_CACHE_TTL_MS,
    actualCacheTtlMs = COST_ACTUAL_CACHE_TTL_MS
  } = {}) {
    this.namespace = namespace;
    this.metrics = new CloudWatchMetricsClient({
      namespace,
      client: cloudwatch || new CloudWatchClient(awsClientConfig('CLOUDWATCH_ENDPOINT', QUERY_CLIENT_OPTIONS)),
      now
    });
    this.local = local;
    this.env = env;
    this.now = now;
    this.cacheTtlMs = cacheTtlMs;
    this.actualCacheTtlMs = actualCacheTtlMs;
    this.cache = new Map();
    this.actualCache = null;
    // Cost Explorer só responde em us-east-1, qualquer que seja a região da stack
    this.costExplorer = costExplorer || (local ? null : new CostExplorerClient({ region: 'us-east-1', ...QUERY_CLIENT_OPTIONS }));
  }

  // apiId: HttpApi da requisição (requestContext); ausente no local-server
  costs({ days, apiId }) {
    const key = `${days}:${apiId || ''}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const value = this.readCosts(days, apiId);
    this.cache.set(key, { value, expiresAt: this.now() + this.cacheTtlMs });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    return value;
  }

  async readCosts(days, apiId) {
    // Dias UTC, como o Cost Explorer; o de hoje entra parcial
    const end = Math.floor(this.now() / DAY_MS) * DAY_MS + DAY_MS;
    const start = end - days * DAY_MS;
    const buckets = [];
    for (let t = start; t < end; t += DAY_MS) buckets.push(t);

    // Uma fonte fora do ar não esconde a outra: a estimativa que falha vira
    // estimatedError (como actualReason no Cost Explorer); 503 só sem nenhuma
    const [estimated, actual] = await Promise.allSettled([
      this.estimate(start, end, buckets, apiId),
      this.local
        ? { actual: null, forecast: null, actualReason: 'Cost Explorer não existe no LocalStack' }
        : this.readActual(buckets)
    ]);
    if (estimated.status === 'rejected' && !actual.value?.actual) throw estimated.reason;
    const budget = Number(this.env.MONTHLY_BUDGET_USD);

    return {
      days,
      currency: 'USD',
      buckets: buckets.map(isoDay),
      estimated: estimated.value ?? null,
      ...(estimated.status === 'rejected' && { estimatedError: `Estimativa indisponível: ${estimated.reason.message}` }),
      ...actual.value,
      budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null
    };
  }

  // ---- estimativa -------------------------------------------------------

  async estimate(start, end, buckets, apiId) {
    const names = await this.metrics.dimensionValues('MemoryUsedMB', ['FunctionName']);
    const plan = this.local ? this.localQueries(names) : this.awsQueries(names, apiId);
    const results = await this.metrics.getMetricData(plan.queries, start, end);
    const series = id => {
      const values = buckets.map(() => 0);
      const result = results.get(id);
      result?.timestamps.forEach((t, k) => {
        const index = Math.floor((t - start) / DAY_MS);
        if (index >= 0 && index < values.length) values[index] += result.values[k];
      });
      return values;
    };

    const byService = plan.services
      .map(({ service, cost }) => {
        const values = buckets.map((_, i) => round(cost(id => series(id)[i])));
        return { service, values, total: round(sum(values)) };
      })
      .filter(s => s.total > 0)
      .sort((a, b) => b.total - a.total);

    return { total: round(sum(byService.map(s => s.total))), byService, notes: plan.notes };
  }

  query(Id, Namespace, MetricName, Stat, dimensions) {
    return {
      Id,
      ReturnData: true,
      MetricStat: {
        Metric: { Namespace, MetricName, Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })) },
        Period: DAY_S,
        Stat
      }
    };
  }

  // memoryMb: um MemorySize por função (o authorizer tem o dele)
  lambdaCost(memoryMb, durationMs, invocations) {
    return value => sum(memoryMb.map((mb, i) =>
      value(durationMs(i)) / 1000 * (mb / 1024) * PRICES.lambdaGbSecondArm + value(invocations(i)) * PRICES.lambdaRequest));
  }

  awsQueries(names, apiId) {
    // As funções vêm do MemoryUsedMB (runtime-metrics.mjs); o authorizer não
    // passa por ele e entra pelo nome que o template passa
    const functions = names.map(name => ({ name, memoryMb: functionMemoryMb(this.env) }));
    const authorizer = this.env.AUTHORIZER_FUNCTION_NAME;
    if (authorizer && !names.includes(authorizer)) {
      functions.push({ name: authorizer, memoryMb: Number(this.env.AUTHORIZER_MEMORY_MB) || 128 });
    }
    const queries = functions.flatMap(({ name: FunctionName }, i) => [
      this.query(`lambda_ms_${i}`, 'AWS/Lambda', 'Duration', 'Sum', { FunctionName }),
      this.query(`lambda_n_${i}`, 'AWS/Lambda', 'Invocations', 'Sum', { FunctionName })
    ]);
    const services = [{
      service: SERVICES.lambda,
      cost: this.lambdaCost(functions.map(f => f.memoryMb), i => `lambda_ms_${i}`, i => `lambda_n_${i}`)
    }];

    const stateMachine = this.env.SAGA_STATE_MACHINE_ARN;
    if (stateMachine) {
      queries.push(this.query('sfn', 'AWS/States', 'ExecutionsStarted', 'Sum', { StateMachineArn: stateMachine }));
      services.push({ service: SERVICES.stepFunctions, cost: value => value('sfn') * TRANSITIONS_PER_SAGA * PRICES.stepFunctionsTransition });
    }
    if (apiId) {
      // Mesmas dimensões do HealthDashboard: o stage tem o nome do Environment
      queries.push(this.query('api', 'AWS/ApiGateway', 'Count', 'Sum', { ApiId: apiId, Stage: this.env.ENVIRONMENT || 'dev' }));
      services.push({ service: SERVICES.apiGateway, cost: value => value('api') * PRICES.httpApiRequest });
    }
    const tables = TABLE_ENV.map(key => this.env[key]).filter(Boolean);
    tables.forEach((TableName, i) => queries.push(
      this.query(`ddb_r_${i}`, 'AWS/DynamoDB', 'ConsumedReadCapacityUnits', 'Sum', { TableName }),
      this.query(`ddb_w_${i}`, 'AWS/DynamoDB', 'ConsumedWriteCapacityUnits', 'Sum', { TableName })
    ));
    if (tables.length) {
      services.push({
        service: SERVICES.dynamodb,
        cost: value => sum(tables.map((_, i) => value(`ddb_r_${i}`) * PRICES.dynamoReadUnit + value(`ddb_w_${i}`) * PRICES.dynamoWriteUnit))
      });
    }
    return {
      queries,
      services,
      notes: [
        `Step Functions: ${TRANSITIONS_PER_SAGA} transições por compra (sem compensação)`,
        'Fora da estimativa: free tier, EventBridge, SQS, SNS, CloudWatch (logs, métricas custom, alarmes) e Application Signals'
      ]
    };
  }

  // InvocationDurationMs: Sum = duração, SampleCount = invocações
  localQueries(names) {
    const queries = names.flatMap((FunctionName, i) => [
      this.query(`lambda_ms_${i}`, this.namespace, 'InvocationDurationMs', 'Sum', { FunctionName }),
      this.query(`lambda_n_${i}`, this.namespace, 'InvocationDurationMs', 'SampleCount', { FunctionName })
    ]);
    const steps = names.map((name, i) => [name, i]).filter(([name]) => name.startsWith('local-') && name !== 'local-server').map(([, i]) => `lambda_n_${i}`);
    const server = names.indexOf('local-server');
    const services = [
      { service: SERVICES.lambda, cost: this.lambdaCost(names.map(() => functionMemoryMb(this.env)), i => `lambda_ms_${i}`, i => `lambda_n_${i}`) },
      { service: SERVICES.stepFunctions, cost: value => sum(steps.map(value)) * TRANSITIONS_PER_LOCAL_STEP * PRICES.stepFunctionsTransition }
    ];
    // No local-server cada invocação de handler é uma requisição HTTP (ou um
    // evento entregue em processo): aproxima as requisições do HttpApi
    if (server >= 0) services.push({ service: SERVICES.apiGateway, cost: value => value(`lambda_n_${server}`) * PRICES.httpApiRequest });
    return {
      queries,
      services,
      notes: [
        'Local: o local-server conta como uma Lambda com o MemorySize do template',
        `Step Functions: ${TRANSITIONS_PER_LOCAL_STEP} transições por passo da saga`,
        'DynamoDB fora da estimativa (o LocalStack não publica o consumo)'
      ]
    };
  }

  // ---- Cost Explorer ----------------------------------------------------

  async readActual(buckets) {
    try {
      const data = await this.costExplorerData();
      const days = buckets.map(isoDay);
      const byService = [...data.byService.entries()]
        .map(([service, perDay]) => {
          const values = days.map(day => round(perDay.get(day) || 0));
          return { service, values, total: round(sum(values)) };
        })
        .filter(s => s.total > 0)
        .sort((a, b) => b.total - a.total);
      return {
        actual: { total: round(sum(byService.map(s => s.total))), byService, monthToDate: data.monthToDate, fetchedAt: data.fetchedAt },
        forecast: data.forecast
      };
    } catch (error) {
      return { actual: null, forecast: null, actualReason: `Cost Explorer indisponível: ${error.message}` };
    }
  }

  costExplorerData() {
    if (this.actualCache && this.actualCache.expiresAt > this.now()) return this.actualCache.value;
    const value = this.fetchCostExplorer();
    this.actualCache = { value, expiresAt: this.now() + this.actualCacheTtlMs };
    value.catch(() => { if (this.actualCache?.value === value) this.actualCache = null; });
    return value;
  }

  async fetchCostExplorer() {
    const today = Math.floor(this.now() / DAY_MS) * DAY_MS;
    const tomorrow = today + DAY_MS;
    const date = new Date(today);
    const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const start = Math.min(tomorrow - ACTUAL_WINDOW_DAYS * DAY_MS, monthStart);

    const byService = new Map();
    let NextPageToken;
    do {
      const page = await this.costExplorer.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: isoDay(start), End: isoDay(tomorrow) },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        NextPageToken
      }));
      for (const { TimePeriod, Groups = [] } of page.ResultsByTime || []) {
        for (const { Keys = [], Metrics = {} } of Groups) {
          const amount = Number(Metrics.UnblendedCost?.Amount) || 0;
          if (!byService.has(Keys[0])) byService.set(Keys[0], new Map());
          const perDay = byService.get(Keys[0]);
          perDay.set(TimePeriod.Start, (perDay.get(TimePeriod.Start) || 0) + amount);
        }
      }
      NextPageToken = page.NextPageToken;
    } while (NextPageToken);

    const monthDay = isoDay(monthStart);
    const monthToDate = round(sum([...byService.values()].flatMap(perDay =>
      [...perDay.entries()].filter(([day]) => day >= monthDay).map(([, amount]) => amount))));

    return { byService, monthToDate, forecast: await this.forecast(tomorrow, nextMonth, monthToDate), fetchedAt: new Date(this.now()).toISOString() };
  }

  // Previsão do mês = gasto até hoje + previsão do resto. O Cost Explorer
  // recusa conta sem histórico e o último dia do mês (período vazio): sem previsão
  async forecast(start, end, monthToDate) {
    if (start >= end) return { monthTotal: monthToDate };
    try {
      const { Total } = await this.costExplorer.send(new GetCostForecastCommand({
        TimePeriod: { Start: isoDay(start), End: isoDay(end) },
        Metric: 'UNBLENDED_COST',
        Granularity: 'MONTHLY'
      }));
      return { monthTotal: round(monthToDate + (Number(Total?.Amount) || 0)) };
    } catch {
      return null;
    }
  }
}
