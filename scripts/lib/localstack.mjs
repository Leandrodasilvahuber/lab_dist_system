/**
 * Publica a saga no LocalStack: tabelas, Lambdas dos passos e de produtos (do `sam build`)
 * e a state machine real (workflow/saga-workflow.asl.json).
 * Usado por scripts/localstack-deploy.mjs, scripts/e2e-localstack.mjs e scripts/e2e-errors.mjs.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ddb from '@aws-sdk/client-dynamodb';
import * as lambda from '@aws-sdk/client-lambda';
import * as sfn from '@aws-sdk/client-sfn';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { ensureTable, logicalName } from './tables.mjs';

// Perfil local de timeouts (src/common/aws-client.mjs) das Lambdas
export const LOCAL_TIMEOUT_SCALE = 3;
// No LocalStack, no máximo 2 execuções ao mesmo tempo: cada Lambda local tem
// concorrência reservada 2 (no máximo 2 contêineres por função; o excedente
// recebe throttling, que o Step Functions repete com backoff) e os testes e as
// compras de exemplo disparam 2 por vez (mapLimit, scripts/lib/pool.mjs).
// Na AWS não há reserva: vale a concorrência da conta
export const LOCAL_MAX_CONCURRENCY = 2;
// Timeout das Lambdas no LocalStack: a primeira chamada sobe um contêiner, e
// vários simultâneos levam dezenas de segundos
export const LOCAL_LAMBDA_TIMEOUT_S = 30;
// Teto da execução local: pior caso com passos de 30 s é ~21 min (ver localTimeouts)
export const LOCAL_EXECUTION_TIMEOUT_S = 3600;

// Config de caos (src/common/chaos.mjs) do ambiente local: lida pelas Lambdas
// local-* e pelo local-server, gravada pela aba Caos e por npm run chaos
export const LOCAL_CHAOS_PARAM = '/local/ecommerce/chaos';
export const LOCAL_CHAOS_ENV = { CHAOS_PARAM: LOCAL_CHAOS_PARAM, CHAOS_ENABLED: 'true' };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = path.join(ROOT, '.aws-sam', 'build');
// Lambdas dos passos da saga + ProductFunction (consultada pelo orquestrador ao iniciar)
const STEP_FUNCTIONS = ['OrderFunction', 'PaymentFunction', 'StockFunction', 'ProductFunction'];
const ACCOUNT = '000000000000';

// Mesmo runtime do deploy na AWS (Globals.Function.Runtime do template.yaml)
/**
 * @returns {import('@aws-sdk/client-lambda').Runtime}
 */
export function templateRuntime() {
  const match = fs.readFileSync(path.join(ROOT, 'template.yaml'), 'utf8').match(/^\s+Runtime:\s*(nodejs\S+)/m);
  return /** @type {import('@aws-sdk/client-lambda').Runtime} */ (process.env.E2E_LAMBDA_RUNTIME || match?.[1] || 'nodejs22.x');
}

// MemorySize das Lambdas (parâmetro FunctionMemoryMB do template.yaml): as
// local-* são criadas com ele, e a aba Recursos usa como limite de memória
export function templateMemoryMb() {
  const lines = fs.readFileSync(path.join(ROOT, 'template.yaml'), 'utf8').split('\n');
  const start = lines.findIndex(line => /^\s+FunctionMemoryMB:\s*$/.test(line));
  if (start === -1) return 256;
  // Só as linhas do bloco do parâmetro (mais indentadas que o nome dele): sem
  // Default ali, não pega o do parâmetro seguinte
  const indent = lines[start].search(/\S/);
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    const match = line.match(/^\s+Default:\s*(\d+)/);
    if (match) return Number(match[1]);
  }
  return 256;
}

// Página inicial (HelloFunction do template.yaml): na AWS o CloudFront manda
// '/' para ela; no local quem faz esse papel é o local-server
export const LOCAL_HELLO_FUNCTION = 'local-HelloFunction';

// Código inline da HelloFunction, sem a indentação do YAML: o LocalStack roda
// exatamente o código da produção, sem cópia para manter em dia
export function templateHelloCode() {
  const lines = fs.readFileSync(path.join(ROOT, 'template.yaml'), 'utf8').split('\n');
  const fn = lines.findIndex(line => line.trim() === 'HelloFunction:');
  const start = lines.findIndex((line, i) => i > fn && line.replaceAll(' ', '') === 'InlineCode:|');
  if (fn === -1 || start === -1) throw new Error('InlineCode da HelloFunction não encontrado no template.yaml');
  const indent = lines[start].search(/\S/);
  const end = lines.findIndex((line, i) => i > start && line.trim() && line.search(/\S/) <= indent);
  const block = lines.slice(start + 1, end === -1 ? undefined : end);
  const margin = Math.min(...block.filter(line => line.trim()).map(line => line.search(/\S/)));
  return block.map(line => line.slice(margin)).join('\n').trimEnd() + '\n';
}

export function clients(endpoint) {
  const cfg = { region: 'us-east-1', endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
  return {
    D: new ddb.DynamoDBClient(cfg),
    L: new lambda.LambdaClient(cfg),
    F: new sfn.SFNClient(cfg),
    CW: new CloudWatchClient(cfg),
    Q: new SQSClient(cfg),
    S: new SSMClient(cfg)
  };
}

export function assertBuilt() {
  if (!fs.existsSync(path.join(BUILD, 'OrderFunction', 'index.mjs'))) {
    throw new Error('Build não encontrado. Rode antes: npm run build');
  }
}

// Parâmetro da config de caos com nenhuma falha (como o ChaosConfigParameter
// do template.yaml). Recria vazio: um novo deploy começa sem caos
export async function ensureChaosParameter({ S }, name = LOCAL_CHAOS_PARAM) {
  await S.send(new PutParameterCommand({ Name: name, Value: JSON.stringify({ faults: [] }), Type: 'String', Overwrite: true }));
}

// `tables`: { PRODUCTS_TABLE: 'nome', ... }, com os mesmos índices do template.yaml
export async function ensureTables({ D }, tables) {
  for (const [envKey, TableName] of Object.entries(tables)) {
    await ensureTable(D, logicalName(envKey), TableName);
  }
}

/**
 * Cria (ou recria) as Lambdas dos passos e a state machine.
 * Retorna o ARN da state machine.
 */
export async function deploySaga({ L, F }, { prefix, tables, environment = {} }) {
  assertBuilt();
  const runtime = templateRuntime();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-deploy-'));
  const arns = {};

  try {
    for (const fn of STEP_FUNCTIONS) {
      const FunctionName = `${prefix}-${fn}`;
      const zip = path.join(tmp, `${fn}.zip`);
      execSync(`python3 -m zipfile -c "${zip}" index.mjs`, { cwd: path.join(BUILD, fn) });

      await L.send(new lambda.DeleteFunctionCommand({ FunctionName })).catch(() => {});
      const { FunctionArn } = await L.send(new lambda.CreateFunctionCommand({
        FunctionName,
        Runtime: runtime,
        Handler: 'index.handler',
        Timeout: LOCAL_LAMBDA_TIMEOUT_S,
        MemorySize: templateMemoryMb(),
        Role: `arn:aws:iam::${ACCOUNT}:role/lambda-role`,
        // O LocalStack executa na arquitetura da máquina; o bundle é JS puro
        Architectures: [os.arch() === 'arm64' ? 'arm64' : 'x86_64'],
        Code: { ZipFile: fs.readFileSync(zip) },
        // TIMEOUT_SCALE: perfil local de timeouts (src/common/aws-client.mjs)
        Environment: { Variables: { ...tables, PAYMENT_MAX_AMOUNT: '10000', TIMEOUT_SCALE: String(LOCAL_TIMEOUT_SCALE), FUNCTION_MEMORY_MB: String(templateMemoryMb()), ...environment } }
      }));
      arns[fn] = FunctionArn;
      await lambda.waitUntilFunctionActiveV2({ client: L, maxWaitTime: 180 }, { FunctionName });
      await L.send(new lambda.PutFunctionConcurrencyCommand({ FunctionName, ReservedConcurrentExecutions: LOCAL_MAX_CONCURRENCY }));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const definition = localTimeouts(fs.readFileSync(path.join(ROOT, 'src/ecommerce/saga-orchestrator/workflow/saga-workflow.asl.json'), 'utf8')
    .replaceAll('${OrderFunctionArn}', arns.OrderFunction)
    .replaceAll('${PaymentFunctionArn}', arns.PaymentFunction)
    .replaceAll('${StockFunctionArn}', arns.StockFunction)
    .replaceAll('${SagasTableName}', tables.SAGAS_TABLE));

  const name = `${prefix}-purchase-saga`;
  const stateMachineArn = `arn:aws:states:us-east-1:${ACCOUNT}:stateMachine:${name}`;
  await F.send(new sfn.DeleteStateMachineCommand({ stateMachineArn })).catch(() => {});
  await F.send(new sfn.CreateStateMachineCommand({
    name,
    definition,
    roleArn: `arn:aws:iam::${ACCOUNT}:role/sfn-role`,
    type: 'STANDARD'
  }));

  return { stateMachineArn, runtime };
}

/**
 * Cria (ou recria) a página inicial a partir do InlineCode do template.yaml.
 * O SAM grava InlineCode como index.js (CommonJS); aqui é igual.
 */
export async function deployHello({ L }, FunctionName = LOCAL_HELLO_FUNCTION) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hello-deploy-'));
  try {
    fs.writeFileSync(path.join(tmp, 'index.js'), templateHelloCode());
    execSync('python3 -m zipfile -c hello.zip index.js', { cwd: tmp });
    await L.send(new lambda.DeleteFunctionCommand({ FunctionName })).catch(() => {});
    await L.send(new lambda.CreateFunctionCommand({
      FunctionName,
      Runtime: templateRuntime(),
      Handler: 'index.handler',
      Timeout: LOCAL_LAMBDA_TIMEOUT_S,
      MemorySize: 128,
      Role: `arn:aws:iam::${ACCOUNT}:role/lambda-role`,
      Architectures: [os.arch() === 'arm64' ? 'arm64' : 'x86_64'],
      Code: { ZipFile: fs.readFileSync(path.join(tmp, 'hello.zip')) }
    }));
    await lambda.waitUntilFunctionActiveV2({ client: L, maxWaitTime: 180 }, { FunctionName });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Limites do workflow (scripts/generate-saga-workflow.py) no LocalStack: o
 * passo espera até o timeout da Lambda local, em vez dos 5 s da AWS (onde o
 * cold start leva menos de 1 s); aqui a primeira chamada sobe um contêiner.
 * Com no máximo LOCAL_MAX_CONCURRENCY execuções ao mesmo tempo, a invocação
 * não fica esperando na fila e o limite não corta uma chamada saudável.
 */
export function localTimeouts(definitionJson) {
  const definition = JSON.parse(definitionJson);
  definition.TimeoutSeconds = LOCAL_EXECUTION_TIMEOUT_S;
  for (const state of Object.values(definition.States)) {
    if (state.TimeoutSeconds) state.TimeoutSeconds = LOCAL_LAMBDA_TIMEOUT_S;
  }
  return JSON.stringify(definition);
}

export async function findStateMachine({ F }, prefix) {
  const { stateMachines } = await F.send(new sfn.ListStateMachinesCommand({}));
  return stateMachines.find(sm => sm.name === `${prefix}-purchase-saga`)?.stateMachineArn;
}

export async function removeSaga({ D, L, F }, { prefix, tables }) {
  const ignore = () => {};
  const arn = await findStateMachine({ F }, prefix).catch(ignore);
  if (arn) {
    // Execução ainda rodando continuaria invocando Lambdas que vão sumir
    const { executions = [] } = await F.send(new sfn.ListExecutionsCommand({ stateMachineArn: arn, statusFilter: 'RUNNING' })).catch(() => ({}));
    for (const { executionArn } of executions) {
      await F.send(new sfn.StopExecutionCommand({ executionArn, cause: 'teardown do teste' })).catch(ignore);
    }
    await F.send(new sfn.DeleteStateMachineCommand({ stateMachineArn: arn })).catch(ignore);
  }
  for (const fn of STEP_FUNCTIONS) {
    await L.send(new lambda.DeleteFunctionCommand({ FunctionName: `${prefix}-${fn}` })).catch(ignore);
  }
  await removeTables({ D }, tables);
}

// Recursos dos testes: e2e-<timestamp>-* e e2e-errors-<timestamp>-*
const TEST_RUN = /^(e2e(?:-errors)?-(\d{13}))-/;
export const STALE_RUN_MS = 60 * 60 * 1000;

/**
 * Remove o que execuções anteriores dos testes deixaram para trás (processo
 * morto antes da limpeza): Lambdas, state machines e tabelas com o prefixo de
 * um teste iniciado há mais de STALE_RUN_MS. Execuções mais novas podem estar
 * rodando em outro terminal e ficam.
 */
export async function removeStaleTestRuns({ D, L, F }, { now = Date.now() } = {}) {
  const stale = name => {
    const match = TEST_RUN.exec(name);
    return match && now - Number(match[2]) > STALE_RUN_MS ? match[1] : null;
  };
  const prefixes = new Set();
  const { Functions = [] } = await L.send(new lambda.ListFunctionsCommand({})).catch(() => ({}));
  const { stateMachines = [] } = await F.send(new sfn.ListStateMachinesCommand({})).catch(() => ({}));
  const { TableNames = [] } = await D.send(new ddb.ListTablesCommand({})).catch(() => ({}));
  for (const name of [...Functions.map(f => f.FunctionName), ...stateMachines.map(m => m.name), ...TableNames]) {
    const prefix = stale(name);
    if (prefix) prefixes.add(prefix);
  }
  for (const prefix of prefixes) {
    const tables = Object.fromEntries(TableNames.filter(t => t.startsWith(`${prefix}-`)).map(t => [t, t]));
    await removeSaga({ D, L, F }, { prefix, tables });
  }
  return [...prefixes];
}

/**
 * Ctrl+C, kill ou promessa rejeitada sem tratamento também limpam: sem isso,
 * interromper um teste deixava Lambdas, contêineres, tabelas e state machine
 * pendurados no LocalStack. `cleanup` roda uma vez só.
 */
export function cleanupOnExit(cleanup) {
  let done = false;
  const run = async (code, error) => {
    if (done) return;
    done = true;
    if (error) console.error(error);
    await cleanup().catch(e => console.error(`Limpeza incompleta: ${e.message}`));
    process.exit(code);
  };
  process.once('SIGINT', () => run(130));
  process.once('SIGTERM', () => run(143));
  process.on('uncaughtException', error => run(1, error));
  process.on('unhandledRejection', error => run(1, error));
}

export async function removeTables({ D }, tables) {
  for (const TableName of Object.values(tables || {})) {
    await D.send(new ddb.DeleteTableCommand({ TableName })).catch(() => {});
  }
}
