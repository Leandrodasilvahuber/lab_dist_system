/**
 * Publica a saga no LocalStack: tabelas, Lambdas dos passos e de produtos (do `sam build`)
 * e a state machine real (workflow/saga-workflow.asl.json).
 * Usado por scripts/localstack-deploy.mjs e scripts/e2e-localstack.mjs.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ddb from '@aws-sdk/client-dynamodb';
import * as lambda from '@aws-sdk/client-lambda';
import * as sfn from '@aws-sdk/client-sfn';
import { ensureTable, logicalName } from './tables.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = path.join(ROOT, '.aws-sam', 'build');
// Lambdas dos passos da saga + ProductFunction (consultada pelo orquestrador ao iniciar)
const STEP_FUNCTIONS = ['OrderFunction', 'PaymentFunction', 'StockFunction', 'ProductFunction'];
const ACCOUNT = '000000000000';

// Mesmo runtime do deploy na AWS (Globals.Function.Runtime do template.yaml)
export function templateRuntime() {
  const match = fs.readFileSync(path.join(ROOT, 'template.yaml'), 'utf8').match(/^\s+Runtime:\s*(nodejs\S+)/m);
  return process.env.E2E_LAMBDA_RUNTIME || match?.[1] || 'nodejs22.x';
}

export function clients(endpoint) {
  const cfg = { region: 'us-east-1', endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
  return { D: new ddb.DynamoDBClient(cfg), L: new lambda.LambdaClient(cfg), F: new sfn.SFNClient(cfg) };
}

export function assertBuilt() {
  if (!fs.existsSync(path.join(BUILD, 'OrderFunction', 'index.mjs'))) {
    throw new Error('Build não encontrado. Rode antes: npm run build');
  }
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
        Timeout: 30,
        Role: `arn:aws:iam::${ACCOUNT}:role/lambda-role`,
        // O LocalStack executa na arquitetura da máquina; o bundle é JS puro
        Architectures: [os.arch() === 'arm64' ? 'arm64' : 'x86_64'],
        Code: { ZipFile: fs.readFileSync(zip) },
        Environment: { Variables: { ...tables, PAYMENT_MAX_AMOUNT: '10000', ...environment } }
      }));
      arns[fn] = FunctionArn;
      await lambda.waitUntilFunctionActiveV2({ client: L, maxWaitTime: 180 }, { FunctionName });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const definition = fs.readFileSync(path.join(ROOT, 'src/ecommerce/saga-orchestrator/workflow/saga-workflow.asl.json'), 'utf8')
    .replaceAll('${OrderFunctionArn}', arns.OrderFunction)
    .replaceAll('${PaymentFunctionArn}', arns.PaymentFunction)
    .replaceAll('${StockFunctionArn}', arns.StockFunction)
    .replaceAll('${SagasTableName}', tables.SAGAS_TABLE);

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

export async function findStateMachine({ F }, prefix) {
  const { stateMachines } = await F.send(new sfn.ListStateMachinesCommand({}));
  return stateMachines.find(sm => sm.name === `${prefix}-purchase-saga`)?.stateMachineArn;
}

export async function removeSaga({ D, L, F }, { prefix, tables }) {
  const ignore = () => {};
  const arn = await findStateMachine({ F }, prefix).catch(ignore);
  if (arn) await F.send(new sfn.DeleteStateMachineCommand({ stateMachineArn: arn })).catch(ignore);
  for (const fn of STEP_FUNCTIONS) {
    await L.send(new lambda.DeleteFunctionCommand({ FunctionName: `${prefix}-${fn}` })).catch(ignore);
  }
  for (const TableName of Object.values(tables || {})) {
    await D.send(new ddb.DeleteTableCommand({ TableName })).catch(ignore);
  }
}
