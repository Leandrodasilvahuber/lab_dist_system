#!/usr/bin/env node
/**
 * Teste ponta a ponta do tratamento de erros no LocalStack.
 *
 * Provoca cada tipo de erro com os handlers reais e mostra as linhas de log
 * geradas (src/common/logger.mjs):
 *  - erro tratado (validação/regra de negócio) -> status "warn", sem stack,
 *    não vai para a DLQ e conta em BusinessErrors (por ErrorType);
 *  - erro não tratado (infraestrutura)         -> status "error", com stack,
 *    conta em UnhandledErrors e, se veio de um evento, termina na DLQ.
 * As métricas saem na própria linha, em Embedded Metric Format (bloco _aws).
 *
 * A falha de infraestrutura é real: a tabela de inventário não é criada
 * (DynamoDB responde ResourceNotFoundException), e o serviço de produtos que a
 * saga consulta não responde: o endpoint do Lambda recusa a conexão
 * (ECONNREFUSED) e o circuit breaker abre.
 *
 * No fim, publica as métricas EMF das linhas (o LocalStack não as extrai
 * sozinho) e as observadas e cria os alarmes `local-ecommerce-*`
 * (os mesmos do template.yaml) no CloudWatch do LocalStack, que os avalia;
 * eles aparecem na aba Monitoramento do dashboard (npm run local-server).
 * Alarmes e DLQ ficam; as tabelas do teste são removidas.
 *
 * Pré-requisito: npm run localstack:start (com cloudwatch em SERVICES)
 * Uso:
 *   npm run test:e2e:errors
 *   npm run test:e2e:errors -- --cleanup   # remove alarmes e DLQ locais
 */
import * as cw from '@aws-sdk/client-cloudwatch';
import * as sqs from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { ROOT, clients, ensureTables, removeTables, removeStaleTestRuns, cleanupOnExit } from './lib/localstack.mjs';
import { extractEmfMetrics } from '../src/common/emf.mjs';
import { parseLogLine } from '../src/common/log-query.mjs';

const endpoint = process.env.LOCALSTACK_ENDPOINT || 'http://localhost:4566';
const aws = clients(endpoint);
const ALARM_PREFIX = 'local-ecommerce-';
const ALARMS = {
  unhandledErrors: `${ALARM_PREFIX}unhandled-errors`,
  businessErrors: `${ALARM_PREFIX}business-errors`,
  productEventsDlq: `${ALARM_PREFIX}product-events-dlq`,
  sagaFailed: `${ALARM_PREFIX}saga-failed`,
  sagaCompensationRate: `${ALARM_PREFIX}saga-compensation-rate`,
  api5xx: `${ALARM_PREFIX}api-5xx`,
  circuitOpen: `${ALARM_PREFIX}circuit-open`
};
const DLQ_NAME = 'local-ProductEventsDlq';

const out = console.log.bind(console);
const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);

if (process.argv.includes('--cleanup')) {
  await aws.CW.send(new cw.DeleteAlarmsCommand({ AlarmNames: Object.values(ALARMS) })).catch(e => out(`  alarmes: ${e.message}`));
  const queueUrl = await aws.Q.send(new sqs.GetQueueUrlCommand({ QueueName: DLQ_NAME })).then(r => r.QueueUrl, () => null);
  if (queueUrl) await aws.Q.send(new sqs.DeleteQueueCommand({ QueueUrl: queueUrl }));
  out('Alarmes local-ecommerce-* e DLQ local removidos');
  process.exit(0);
}

const PREFIX = `e2e-errors-${Date.now()}`;
// Sem INVENTORY_TABLE: ela aponta para uma tabela que não existe (falha de infraestrutura)
const T = {
  PRODUCTS_TABLE: `${PREFIX}-Products`,
  ORDERS_TABLE: `${PREFIX}-Orders`,
  STOCK_RESERVATIONS_TABLE: `${PREFIX}-StockReservations`,
  SAGAS_TABLE: `${PREFIX}-Sagas`
};

// Um cenário que lança ou o teste interrompido (Ctrl+C) também remove as
// tabelas desta execução
cleanupOnExit(() => removeTables(aws, T));

try {
  await removeStaleTestRuns(aws);
  await ensureTables(aws, T);
} catch (error) {
  out(`Falha ao preparar o LocalStack em ${endpoint}: ${error.message}`);
  out('Verifique se ele está rodando (npm run localstack:start).');
  process.exit(1);
}

Object.assign(process.env, T, {
  // Limites diários (PurchaseQuota): sem o local-server, que os desliga, os
  // padrões valeriam aqui, todas as compras no mesmo cliente (sem IP)
  DAILY_PURCHASE_LIMIT: '0',
  DAILY_PURCHASE_LIMIT_PER_CLIENT: '0',
  INVENTORY_TABLE: `${PREFIX}-Inventory-inexistente`,
  // A saga consulta o produto invocando esta Lambda num endpoint que recusa a
  // conexão: o serviço de Products está fora do ar (cenário 6, circuit
  // breaker). Função inexistente seria erro de configuração (500), não queda
  PRODUCT_FUNCTION_NAME: `${PREFIX}-ProductFunction`,
  LAMBDA_ENDPOINT: 'http://127.0.0.1:1',
  EVENT_BUS_NAME: '',
  AWS_ENDPOINT: endpoint,
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  LOG_LEVEL: 'info',
  ENVIRONMENT: 'local'
});

// Captura as linhas JSON do logger; mostra só warn/error (info vira ruído aqui)
const logLines = [];
let currentScenario = '';
for (const method of ['log', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (first, ...rest) => {
    const entry = parseLogLine(first);
    if (!entry) return original(first, ...rest);
    logLines.push({ ...entry, scenario: currentScenario });
    if (entry.status === 'warn') original(color(33, `    [log warn ] ${first}`));
    if (entry.status === 'error') original(color(31, `    [log error] ${first.replace(/\\n\s+at [^"]*/, '...')}`));
  };
}

const products = (await import(`${ROOT}/src/ecommerce/products/index.mjs`)).handler;
const orders = (await import(`${ROOT}/src/ecommerce/orders/index.mjs`)).handler;
const stock = (await import(`${ROOT}/src/ecommerce/stock/index.mjs`)).handler;
const saga = (await import(`${ROOT}/src/ecommerce/saga-orchestrator/index.mjs`)).handler;

const ev = (method, path, body, headers = {}) => ({ version: '2.0', rawPath: `/dev${path}`, headers,
  requestContext: { stage: 'dev', http: { method } }, body: body && JSON.stringify(body) });
const call = async (fn, ...a) => { const r = await fn(ev(...a)); return { status: r.statusCode, headers: r.headers, body: JSON.parse(r.body) }; };
const productCreated = detail => ({ source: 'products', 'detail-type': 'ProductCreated', detail });

let failures = 0;
const check = (label, cond) => { out(`  ${cond ? '✔' : '✘'} ${label}`); if (!cond) failures++; };
function scenario(title) {
  currentScenario = title;
  out(`\n${title}`);
  const mark = logLines.length;
  return (event) => logLines.slice(mark).filter(l => l.event === event);
}

// ---------- 1 ----------
let lines = scenario('1) HTTP, erro de negócio: POST /products com preço 0');
let r = await call(products, 'POST', '/products', { name: 'Brinde', price: 0 });
check(`responde 400 (${r.body.error})`, r.status === 400);
let [line] = lines('API_REJECTED');
check('log warn API_REJECTED com o status 400', line?.status === 'warn' && line.data?.statusCode === 400);
check('métrica EMF BusinessErrors com ErrorType HTTP_400', line?.BusinessErrors === 1 && line.ErrorType === 'HTTP_400' && line._aws);
check('nenhuma linha error', !logLines.some(l => l.scenario === currentScenario && l.status === 'error'));

// ---------- 2 ----------
lines = scenario('2) Ação da saga, erro de negócio: confirmOrder de pedido inexistente');
const thrown = await orders({ action: 'confirmOrder', input: { orderId: 'nao-existe', correlationId: 'e2e-errors' } }).catch(e => e);
check(`ação lança ${thrown?.name} (o Step Functions compensa sem repetir)`, thrown instanceof Error && thrown.name === 'NotFound');
[line] = lines('ACTION_REJECTED');
check('log warn ACTION_REJECTED, errorType NotFound, sem stack', line?.status === 'warn' && line.errorType === 'NotFound' && !line.stack);
check('métricas EMF: BusinessErrors NotFound e ActionCount confirmOrder/rejected',
  line?.BusinessErrors === 1 && line.ErrorType === 'NotFound' && line.ActionCount === 1 && line.Action === 'confirmOrder' && line.Outcome === 'rejected');

// ---------- 3 ----------
lines = scenario('3) Evento, erro de negócio: ProductCreated com initialStock -1');
const rejected = await stock(productCreated({ productId: 'p-invalido', name: 'Inválido', initialStock: -1 }));
check('evento confirmado com { rejected: true } (não vai para a DLQ)', rejected?.rejected === true);
[line] = lines('DOMAIN_EVENT_REJECTED');
check('log warn DOMAIN_EVENT_REJECTED, errorType ValidationError', line?.status === 'warn' && line.errorType === 'ValidationError');
check('uma linha só (sem ACTION_REJECTED duplicado)', logLines.filter(l => l.scenario === currentScenario && l.status === 'warn').length === 1);
check('BusinessErrors contado uma vez só', logLines.filter(l => l.scenario === currentScenario && l.BusinessErrors).length === 1);

// ---------- 4 ----------
lines = scenario('4) Evento, falha transitória: ProductCreated sem a tabela de inventário');
const { QueueUrl: dlqUrl } = await aws.Q.send(new sqs.CreateQueueCommand({ QueueName: DLQ_NAME }));
const dlqSize = async () => Number((await aws.Q.send(new sqs.GetQueueAttributesCommand({
  QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }))).Attributes.ApproximateNumberOfMessages);
const dlqBefore = await dlqSize();
const event = productCreated({ productId: 'p-transitorio', name: 'Transitório', initialStock: 5 });
// Imita a invocação assíncrona da AWS: a Lambda tenta 3 vezes (1 + MaximumRetryAttempts: 2
// do EventInvokeConfig) e o destino OnFailure grava o registro da invocação na DLQ
const ATTEMPTS = 3;
let lastError;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  lastError = await stock(event).then(() => null, e => e);
  if (!lastError) break;
}
check(`as ${ATTEMPTS} tentativas falham com ${lastError?.name}`, lastError?.name === 'ResourceNotFoundException');
if (lastError) {
  await aws.Q.send(new sqs.SendMessageCommand({ QueueUrl: dlqUrl, MessageBody: JSON.stringify({
    version: '1.0',
    timestamp: new Date().toISOString(),
    requestContext: { condition: 'RetriesExhausted', approximateInvokeCount: ATTEMPTS },
    requestPayload: event,
    responseContext: { statusCode: 200, functionError: 'Unhandled' },
    responsePayload: { errorType: lastError.name, errorMessage: lastError.message }
  }) }));
}
const failed = lines('ACTION_FAILED');
check(`log error ACTION_FAILED em cada tentativa (${failed.length}), com errorType e stack`,
  failed.length === ATTEMPTS && failed.every(l => l.status === 'error' && l.errorType === 'ResourceNotFoundException' && l.stack));
check('evento foi para a DLQ (+1 mensagem)', await dlqSize() === dlqBefore + 1);

// ---------- 5 ----------
lines = scenario('5) HTTP, erro não tratado: GET /stock sem a tabela de inventário');
r = await call(stock, 'GET', '/stock');
check(`responde 500 sem vazar detalhes (${JSON.stringify(r.body)})`, r.status === 500 && r.body.error === 'Failed to get stock');
[line] = lines('UNEXPECTED_ERROR');
check('log error UNEXPECTED_ERROR com errorType e stack', line?.status === 'error' && line.errorType === 'ResourceNotFoundException' && line.stack);

// ---------- 6 ----------
lines = scenario('6) Dependência fora do ar: compras com o serviço de Products indisponível (circuit breaker)');
// O breaker abre depois de N falhas seguidas. N vem do próprio ProductClient,
// criado com o mesmo ambiente: no perfil local (AWS_ENDPOINT) ele tolera mais
// falhas que na AWS, e um número fixo aqui deixaria o teste fora de sincronia
const { ProductClient } = await import(`${ROOT}/src/common/product-client.mjs`);
const THRESHOLD = new ProductClient().breaker.failureThreshold;
const buy = () => call(saga, 'POST', '/saga/execute', { productId: 'p-qualquer', quantity: 1 }, { 'idempotency-key': randomUUID() });
const beforeOpen = [];
for (let i = 0; i < THRESHOLD; i++) beforeOpen.push(await buy());
check(`as ${THRESHOLD} primeiras compras respondem 503 com Retry-After (Products indisponível)`,
  beforeOpen.every(b => b.status === 503 && b.headers['Retry-After'] && /Product service unavailable/.test(b.body.error)));
const started = Date.now();
const whileOpen = await buy();
const openMs = Date.now() - started;
check(`com o circuito aberto responde 503 na hora, sem invocar a Lambda (${openMs} ms, Retry-After ${whileOpen.headers['Retry-After']}s)`,
  whileOpen.status === 503 && /circuit open/.test(whileOpen.body.error) && Number(whileOpen.headers['Retry-After']) > 0);
const opened = lines('CIRCUIT_STATE_CHANGED');
check(`log error CIRCUIT_STATE_CHANGED closed -> open, com a causa (${opened[0]?.error})`,
  opened.length === 1 && opened[0].status === 'error' && opened[0].data?.to === 'open' && /ECONNREFUSED/.test(opened[0].error));
check('métrica EMF CircuitOpened com Circuit=products (e não BusinessErrors)',
  opened[0]?.CircuitOpened === 1 && opened[0].Circuit === 'products' && !opened[0].BusinessErrors);
const unavailable = lines('DEPENDENCY_UNAVAILABLE');
check(`cada falha da Lambda gera log error DEPENDENCY_UNAVAILABLE (${unavailable.filter(l => l.status === 'error').length})`,
  unavailable.filter(l => l.status === 'error').length === THRESHOLD);
check('a recusa com o circuito aberto é só info (a abertura já é o error)',
  unavailable.filter(l => l.status === 'info').length === 1);
const responses5xx = [r, ...beforeOpen, whileOpen].filter(x => x.status >= 500).length;

await removeTables(aws, T);

// ---------- Resumo ----------
const problems = logLines.filter(l => l.status === 'warn' || l.status === 'error');
const warns = problems.filter(l => l.status === 'warn').length;
const errors = problems.length - warns;
out('\nLinhas de log de erro geradas:');
console.table(problems.map(l => ({
  nível: l.status, evento: l.event, errorType: l.errorType ?? '—', stack: l.stack ? 'sim' : 'não', cenário: l.scenario.split(')')[0]
})));
out(`${warns} warn (tratados: métrica BusinessErrors) · ${errors} error (não tratados: métrica UnhandledErrors)`);

// O que o CloudWatch extrairia na AWS: uma entrada por métrica × conjunto de dimensões
const emfData = logLines.flatMap(extractEmfMetrics);
const emfTotal = name => emfData.filter(d => d.MetricName === name && !d.Dimensions.length).reduce((a, d) => a + d.Value, 0);
const circuitOpened = emfData.filter(d => d.MetricName === 'CircuitOpened' && d.Dimensions.some(x => x.Name === 'Circuit' && x.Value === 'products'))
  .reduce((a, d) => a + d.Value, 0);
check(`EMF: BusinessErrors=${emfTotal('BusinessErrors')} igual aos warn, UnhandledErrors=${emfTotal('UnhandledErrors')} igual aos error`,
  emfTotal('BusinessErrors') === warns && emfTotal('UnhandledErrors') === errors);

// ---------- Alarmes no CloudWatch do LocalStack ----------
out('\nAlarmes no CloudWatch do LocalStack');
// Mesmos alarmes do template.yaml, com três diferenças locais:
//  - o LocalStack não extrai Embedded Metric Format, não aplica metric filter
//    nem publica métricas de SQS/API Gateway/Step Functions, então o script
//    publica em Ecommerce/local as métricas EMF das linhas e os valores que o
//    teste observou (saga-failed e saga-compensation-rate usam metric math na
//    AWS; aqui são uma métrica simples com o valor final, e este teste não
//    executa saga);
//  - limiar 0 (business-errors é >= 20 em 5 min na AWS) para os poucos erros
//    do teste dispararem; saga-compensation-rate mantém o limiar de 5%;
//  - período de 60 s (o LocalStack avalia a cada período) e 1 ponto em 15
//    períodos, para o alarme ficar ~15 min em ALARM e dar tempo de ver no dashboard.
const dlqTotal = await dlqSize();
const observed = {
  UnhandledErrors: emfTotal('UnhandledErrors'),
  BusinessErrors: emfTotal('BusinessErrors'),
  ProductEventsDlqMessages: dlqTotal,
  SagaExecutionsFailed: 0,
  SagaCompensationRate: 0,
  Api5xx: responses5xx,
  CircuitOpened: circuitOpened
};
const alarm = (AlarmName, AlarmDescription, MetricName, Threshold = 0, Dimensions) => ({
  AlarmName, AlarmDescription, Namespace: 'Ecommerce/local', MetricName, Statistic: 'Sum', ...(Dimensions && { Dimensions }),
  Period: 60, EvaluationPeriods: 15, DatapointsToAlarm: 1,
  ComparisonOperator: 'GreaterThanThreshold', Threshold, TreatMissingData: 'notBreaching'
});
const definitions = [
  alarm(ALARMS.unhandledErrors, 'Erros não tratados nos logs das Lambdas', 'UnhandledErrors'),
  alarm(ALARMS.businessErrors, 'Volume alto de erros de negócio (ver aba Métricas, por ErrorType)', 'BusinessErrors'),
  alarm(ALARMS.productEventsDlq, 'Eventos de produto na DLQ: inventário não criado/removido, reprocessar', 'ProductEventsDlqMessages'),
  alarm(ALARMS.sagaFailed, 'Saga que nem a compensação conseguiu fechar: CompensationFailed/SagaFailed/timeout', 'SagaExecutionsFailed'),
  alarm(ALARMS.sagaCompensationRate, 'Mais de 5% das sagas compensadas (cartão recusado, falta de estoque...): fora do patamar normal',
    'SagaCompensationRate', 5),
  alarm(ALARMS.api5xx, 'Respostas 5xx da API', 'Api5xx'),
  alarm(ALARMS.circuitOpen, 'Circuit breaker products aberto: compras recusadas com 503 (ver CIRCUIT_STATE_CHANGED nos logs e a saúde da ProductFunction)',
    'CircuitOpened', 0, [{ Name: 'Circuit', Value: 'products' }])
];
try {
  // EMF das linhas (como o agente do local-server faz) + métricas nativas observadas
  const nativeMetrics = ['ProductEventsDlqMessages', 'SagaExecutionsFailed', 'SagaCompensationRate', 'Api5xx']
    .map(MetricName => ({ MetricName, Value: observed[MetricName], Unit: MetricName === 'SagaCompensationRate' ? 'Percent' : 'Count' }));
  // Namespace vai no PutMetricData, não em cada métrica
  const metricData = [...emfData.map(({ Namespace: _namespace, ...datum }) => datum), ...nativeMetrics];
  for (let i = 0; i < metricData.length; i += 1000) {
    await aws.CW.send(new cw.PutMetricDataCommand({ Namespace: 'Ecommerce/local', MetricData: metricData.slice(i, i + 1000) }));
  }
  // Recria do zero: o LocalStack mantém campos antigos (ex.: Dimensions) ao atualizar
  await aws.CW.send(new cw.DeleteAlarmsCommand({ AlarmNames: definitions.map(d => d.AlarmName) }));
  for (const definition of definitions) await aws.CW.send(new cw.PutMetricAlarmCommand(definition));
  out(`  métricas publicadas: ${Object.entries(observed).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  // Espera o LocalStack avaliar (até ~2 períodos)
  const expected = Object.fromEntries(definitions.map(d => [d.AlarmName, observed[d.MetricName] > d.Threshold ? 'ALARM' : 'OK']));
  out('  aguardando a avaliação dos alarmes pelo LocalStack (até 2 min)...');
  let alarms = [];
  for (let i = 0; i < 26; i++) {
    ({ MetricAlarms: alarms } = await aws.CW.send(new cw.DescribeAlarmsCommand({ AlarmNamePrefix: ALARM_PREFIX })));
    if (alarms.every(a => a.StateValue === expected[a.AlarmName])) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  for (const a of alarms) {
    out(`  ${a.StateValue === 'ALARM' ? color(31, 'ALARM') : color(32, a.StateValue.padEnd(5))} ${a.AlarmName}: ${a.StateReason}`);
  }
  check('alarmes no estado esperado (5 em ALARM; saga-failed e saga-compensation-rate OK)', alarms.length === definitions.length && alarms.every(a => a.StateValue === expected[a.AlarmName]));
  out('\nVeja nas abas 🩺 Monitoramento e 📊 Métricas: npm run local-server e abra http://localhost:3001');
  out('Os alarmes voltam a OK sozinhos ~15 min depois. Para limpar: npm run test:e2e:errors -- --cleanup');
} catch (error) {
  out(`  CloudWatch indisponível no LocalStack (${error.name}): alarmes não criados.`);
  out('  Ative com cloudwatch em SERVICES (docker-compose.yml) e recrie o container:');
  out('  npm run localstack:stop && npm run localstack:start && npm run seed:local');
}

out(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : failures + ' VERIFICAÇÕES FALHARAM'}`);
process.exit(failures ? 1 : 0);
