#!/usr/bin/env node
/**
 * Teste ponta a ponta do tratamento de erros no LocalStack.
 *
 * Provoca cada tipo de erro com os handlers reais e mostra as linhas de log
 * geradas (src/common/logger.mjs):
 *  - erro tratado (validação/regra de negócio) -> status "warn", sem stack,
 *    não vai para a DLQ nem conta para alarme;
 *  - erro não tratado (infraestrutura)         -> status "error", com stack,
 *    conta em UnhandledErrors e, se veio de um evento, termina na DLQ.
 *
 * A falha de infraestrutura é real: a tabela de inventário não é criada
 * (DynamoDB responde ResourceNotFoundException).
 *
 * No fim, publica as métricas observadas e cria os alarmes `local-ecommerce-*`
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
import { ROOT, clients, ensureTables, removeTables } from './lib/localstack.mjs';

const endpoint = process.env.LOCALSTACK_ENDPOINT || 'http://localhost:4566';
const aws = clients(endpoint);
const ALARM_PREFIX = 'local-ecommerce-';
const ALARMS = {
  unhandledErrors: `${ALARM_PREFIX}unhandled-errors`,
  productEventsDlq: `${ALARM_PREFIX}product-events-dlq`,
  sagaFailed: `${ALARM_PREFIX}saga-failed`,
  api5xx: `${ALARM_PREFIX}api-5xx`
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
  STOCK_RESERVATIONS_TABLE: `${PREFIX}-StockReservations`
};

try {
  await ensureTables(aws, T);
} catch (error) {
  out(`Falha ao preparar o LocalStack em ${endpoint}: ${error.message}`);
  out('Verifique se ele está rodando (npm run localstack:start).');
  process.exit(1);
}

Object.assign(process.env, T, {
  INVENTORY_TABLE: `${PREFIX}-Inventory-inexistente`,
  EVENT_BUS_NAME: '',
  AWS_ENDPOINT: endpoint,
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  LOG_LEVEL: 'info'
});

// Captura as linhas JSON do logger; mostra só warn/error (info vira ruído aqui)
const logLines = [];
let currentScenario = '';
for (const method of ['log', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (first, ...rest) => {
    let entry;
    try { entry = typeof first === 'string' && first.startsWith('{') ? JSON.parse(first) : null; } catch { entry = null; }
    if (!entry?.event) return original(first, ...rest);
    logLines.push({ ...entry, scenario: currentScenario });
    if (entry.status === 'warn') original(color(33, `    [log warn ] ${first}`));
    if (entry.status === 'error') original(color(31, `    [log error] ${first.replace(/\\n\s+at [^"]*/, '...')}`));
  };
}

const products = (await import(`${ROOT}/src/ecommerce/products/index.mjs`)).handler;
const orders = (await import(`${ROOT}/src/ecommerce/orders/index.mjs`)).handler;
const stock = (await import(`${ROOT}/src/ecommerce/stock/index.mjs`)).handler;

const ev = (method, path, body) => ({ version: '2.0', rawPath: `/dev${path}`, headers: {},
  requestContext: { stage: 'dev', http: { method } }, body: body && JSON.stringify(body) });
const call = async (fn, ...a) => { const r = await fn(ev(...a)); return { status: r.statusCode, body: JSON.parse(r.body) }; };
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
check('nenhuma linha error', !logLines.some(l => l.scenario === currentScenario && l.status === 'error'));

// ---------- 2 ----------
lines = scenario('2) Ação da saga, erro de negócio: confirmOrder de pedido inexistente');
const thrown = await orders({ action: 'confirmOrder', input: { orderId: 'nao-existe', correlationId: 'e2e-errors' } }).catch(e => e);
check(`ação lança ${thrown?.name} (o Step Functions compensa sem repetir)`, thrown instanceof Error && thrown.name === 'NotFound');
[line] = lines('ACTION_REJECTED');
check('log warn ACTION_REJECTED, errorType NotFound, sem stack', line?.status === 'warn' && line.errorType === 'NotFound' && !line.stack);

// ---------- 3 ----------
lines = scenario('3) Evento, erro de negócio: ProductCreated com initialStock -1');
const rejected = await stock(productCreated({ productId: 'p-invalido', name: 'Inválido', initialStock: -1 }));
check('evento confirmado com { rejected: true } (não vai para a DLQ)', rejected?.rejected === true);
[line] = lines('DOMAIN_EVENT_REJECTED');
check('log warn DOMAIN_EVENT_REJECTED, errorType ValidationError', line?.status === 'warn' && line.errorType === 'ValidationError');

// ---------- 4 ----------
lines = scenario('4) Evento, falha transitória: ProductCreated sem a tabela de inventário');
const { QueueUrl: dlqUrl } = await aws.Q.send(new sqs.CreateQueueCommand({ QueueName: DLQ_NAME }));
const dlqSize = async () => Number((await aws.Q.send(new sqs.GetQueueAttributesCommand({
  QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }))).Attributes.ApproximateNumberOfMessages);
const dlqBefore = await dlqSize();
const event = productCreated({ productId: 'p-transitorio', name: 'Transitório', initialStock: 5 });
// Imita a regra do EventBridge (RetryPolicy + DeadLetterConfig), com 3 tentativas em vez de 20
const ATTEMPTS = 3;
let lastError;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  lastError = await stock(event).then(() => null, e => e);
  if (!lastError) break;
}
check(`as ${ATTEMPTS} tentativas falham com ${lastError?.name}`, lastError?.name === 'ResourceNotFoundException');
if (lastError) {
  await aws.Q.send(new sqs.SendMessageCommand({ QueueUrl: dlqUrl, MessageBody: JSON.stringify(event),
    MessageAttributes: { ERROR_MESSAGE: { DataType: 'String', StringValue: lastError.message } } }));
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

await removeTables(aws, T);

// ---------- Resumo ----------
const problems = logLines.filter(l => l.status === 'warn' || l.status === 'error');
const warns = problems.filter(l => l.status === 'warn').length;
const errors = problems.length - warns;
out('\nLinhas de log de erro geradas:');
console.table(problems.map(l => ({
  nível: l.status, evento: l.event, errorType: l.errorType ?? '—', stack: l.stack ? 'sim' : 'não', cenário: l.scenario.split(')')[0]
})));
out(`${warns} warn (tratados: não contam para alarme) · ${errors} error (não tratados: métrica UnhandledErrors)`);

// ---------- Alarmes no CloudWatch do LocalStack ----------
out('\nAlarmes no CloudWatch do LocalStack');
// Mesmos alarmes do template.yaml, com duas diferenças locais:
//  - o LocalStack não aplica metric filters nem publica métricas de SQS/API
//    Gateway/Step Functions, então o script publica em Ecommerce/local os
//    valores que o teste observou;
//  - período de 60 s (o LocalStack avalia a cada período) e 1 ponto em 15
//    períodos, para o alarme ficar ~15 min em ALARM e dar tempo de ver no dashboard.
const dlqTotal = await dlqSize();
const observed = {
  UnhandledErrors: errors,
  ProductEventsDlqMessages: dlqTotal,
  SagaExecutionsFailed: 0,
  Api5xx: r.status >= 500 ? 1 : 0
};
const alarm = (AlarmName, AlarmDescription, MetricName) => ({
  AlarmName, AlarmDescription, Namespace: 'Ecommerce/local', MetricName, Statistic: 'Sum',
  Period: 60, EvaluationPeriods: 15, DatapointsToAlarm: 1,
  ComparisonOperator: 'GreaterThanThreshold', Threshold: 0, TreatMissingData: 'notBreaching'
});
const definitions = [
  alarm(ALARMS.unhandledErrors, 'Erros não tratados nos logs das Lambdas', 'UnhandledErrors'),
  alarm(ALARMS.productEventsDlq, 'Eventos de produto na DLQ: inventário não criado/removido, reprocessar', 'ProductEventsDlqMessages'),
  alarm(ALARMS.sagaFailed, 'Execuções da saga de compra que falharam', 'SagaExecutionsFailed'),
  alarm(ALARMS.api5xx, 'Respostas 5xx da API', 'Api5xx')
];
try {
  await aws.CW.send(new cw.PutMetricDataCommand({
    Namespace: 'Ecommerce/local',
    MetricData: Object.entries(observed).map(([MetricName, Value]) => ({ MetricName, Value, Unit: 'Count' }))
  }));
  // Recria do zero: o LocalStack mantém campos antigos (ex.: Dimensions) ao atualizar
  await aws.CW.send(new cw.DeleteAlarmsCommand({ AlarmNames: definitions.map(d => d.AlarmName) }));
  for (const definition of definitions) await aws.CW.send(new cw.PutMetricAlarmCommand(definition));
  out(`  métricas publicadas: ${Object.entries(observed).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  // Espera o LocalStack avaliar (até ~2 períodos)
  const expected = Object.fromEntries(definitions.map(d => [d.AlarmName, observed[d.MetricName] > 0 ? 'ALARM' : 'OK']));
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
  check('alarmes no estado esperado (3 em ALARM, saga-failed OK)', alarms.length === definitions.length && alarms.every(a => a.StateValue === expected[a.AlarmName]));
  out('\nVeja na aba 🩺 Monitoramento: npm run local-server e abra http://localhost:3001');
  out('Os alarmes voltam a OK sozinhos ~15 min depois. Para limpar: npm run test:e2e:errors -- --cleanup');
} catch (error) {
  out(`  CloudWatch indisponível no LocalStack (${error.name}): alarmes não criados.`);
  out('  Ative com cloudwatch em SERVICES (docker-compose.yml) e recrie o container:');
  out('  npm run localstack:stop && npm run localstack:start && npm run seed:local');
}

out(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : failures + ' VERIFICAÇÕES FALHARAM'}`);
process.exit(failures ? 1 : 0);
