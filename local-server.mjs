#!/usr/bin/env node
/**
 * API Gateway local para o dashboard.
 *
 * Recebe as requisições HTTP, monta o mesmo evento (payload 2.0) que o HttpApi
 * envia na AWS e chama os handlers reais dos serviços. Os serviços usam o
 * DynamoDB do LocalStack, e a compra roda na state machine publicada por
 * `npm run localstack:deploy`.
 *
 * Uso:
 *   npm run localstack:start
 *   npm run build && npm run localstack:deploy
 *   npm run local-server        # abra http://localhost:3001
 *   npm run seed:local          # dev: catálogo + compras de exemplo (ou seed:local:prod)
 *
 * O servidor não cria dados de exemplo: catálogo, estoque e as compras de
 * exemplo vêm do seed (scripts/seed.mjs).
 *
 * Com ADMIN_API_KEY_HASH (ou ADMIN_API_KEY) definida, as rotas administrativas
 * (src/common/auth.mjs) exigem o header X-Api-Key, como o authorizer do HttpApi faz
 * na AWS. O `npm run local-server` lê o .env da raiz (se existir); prefira guardar
 * lá só o hash, gerado por `npm run admin:hash`, em vez da chave em texto puro.
 *
 * Escuta só em 127.0.0.1 (as rotas de admin podem estar abertas). Para expor
 * na rede local, defina HOST=0.0.0.0 junto com a chave de admin.
 *
 * O dashboard é servido daqui (mesma origem), então o servidor não manda
 * Access-Control-Allow-Origin: outro site aberto no navegador não consegue
 * chamar a API local. Para liberar uma origem, defina CORS_ALLOW_ORIGIN.
 * Sem chave de admin, só aceita o header Host de loopback (barra DNS rebinding).
 */
import './scripts/lib/local-env.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SFNClient, ListStateMachinesCommand } from '@aws-sdk/client-sfn';
import { isAdminRoute, isValidApiKey, isValidApiKeyHash } from './src/common/auth.mjs';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { createLogBuffer, parseLogLine, isTraceId } from './src/common/log-query.mjs';
import { createEmfAgent } from './scripts/lib/emf-agent.mjs';
import { createLocalstackHealth } from './scripts/lib/localstack-health.mjs';
import { LOCAL_CHAOS_PARAM, templateMemoryMb } from './scripts/lib/localstack.mjs';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from './src/common/database.mjs';
import { SAGAS_BY_DAY_INDEX, dayShardsInWindow } from './src/common/saga-day-index.mjs';
import { CORS_HEADERS } from './src/common/response.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const STATE_MACHINE_NAME = 'local-purchase-saga';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const ADMIN_API_KEY_HASH = process.env.ADMIN_API_KEY_HASH;
const ADMIN_AUTH_ENABLED = Boolean(ADMIN_API_KEY_HASH || ADMIN_API_KEY);
// Só com opt-in explícito: o padrão '*' de response.mjs vale para a AWS, não aqui
const ALLOWED_ORIGIN = process.env.CORS_ALLOW_ORIGIN;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// O hash tem prioridade: com ele, a chave em texto puro não precisa estar em lugar nenhum
const isAuthorizedAdmin = async headers => ADMIN_API_KEY_HASH
  ? isValidApiKeyHash(headers, ADMIN_API_KEY_HASH)
  : isValidApiKey(headers, ADMIN_API_KEY);

// Os serviços leem a configuração ao carregar, então ela vem antes dos imports
// dinâmicos (endpoint e credenciais: scripts/lib/local-env.mjs, primeiro import)

async function findStateMachineArn() {
  try {
    const sfn = new SFNClient({ region: process.env.AWS_REGION, endpoint: process.env.AWS_ENDPOINT });
    const { stateMachines } = await sfn.send(new ListStateMachinesCommand({}));
    return stateMachines.find(sm => sm.name === STATE_MACHINE_NAME)?.stateMachineArn;
  } catch {
    return undefined;
  }
}

process.env.SAGA_STATE_MACHINE_ARN ||= await findStateMachineArn() || '';
// A saga consulta o produto invocando a Lambda publicada por `npm run localstack:deploy`
process.env.PRODUCT_FUNCTION_NAME ||= 'local-ProductFunction';
// Cold start de Lambda no LocalStack (contêiner) passa do teto de 5s da AWS
process.env.PRODUCT_TIMEOUT_MS ||= '30000';
// GET /alarms lista só os alarmes do ambiente local (mesmo padrão de nome do template.yaml)
process.env.ALARM_PREFIX ||= 'local-ecommerce-';
// GET /dlq lê a DLQ local (criada pelo npm run test:e2e:errors)
process.env.DLQ_NAME ||= 'local-ProductEventsDlq';
// Aba Recursos: limite de memória das Lambdas local-* e base da estimativa de custo
process.env.FUNCTION_MEMORY_MB ||= String(templateMemoryMb());
// Injeção de falhas: mesmo parâmetro do SSM que as Lambdas local-* leem
// (criado por npm run localstack:deploy; aba Caos e npm run chaos)
process.env.CHAOS_PARAM ||= LOCAL_CHAOS_PARAM;
process.env.CHAOS_ENABLED ||= 'true';
// Limites diários de compras (PurchaseQuota): local não custa nada, e o npm
// run chaos passaria do teto. Para testar: DAILY_PURCHASE_LIMIT=150
// DAILY_PURCHASE_LIMIT_PER_CLIENT=20
process.env.DAILY_PURCHASE_LIMIT ??= '0';
process.env.DAILY_PURCHASE_LIMIT_PER_CLIENT ??= '0';

const { TIMEOUT_SCALE } = await import('./src/common/aws-client.mjs');

const handlers = {
  products: (await import('./src/ecommerce/products/index.mjs')).handler,
  orders: (await import('./src/ecommerce/orders/index.mjs')).handler,
  stock: (await import('./src/ecommerce/stock/index.mjs')).handler,
  saga: (await import('./src/ecommerce/saga-orchestrator/index.mjs')).handler,
  gateway: (await import('./src/layers/api-gateway-layer/src/routes/apiRoutes.js')).handler
};

// Sem EventBridge local: ProductCreated é entregue ao Stock em processo (como a regra faria na AWS)
const { eventBus } = await import('./src/common/event-bus.mjs');
eventBus.subscribe('products', 'ProductCreated', handlers.stock);
eventBus.subscribe('products', 'ProductDeleted', handlers.stock);

// Sem CloudWatch Logs aqui: os handlers rodam neste processo, então as linhas
// do logger ficam num buffer em memória servido em GET /logs e GET /trace/{id}.
// Os passos da saga rodam nas Lambdas local-* do LocalStack: o agente EMF lê os
// log groups delas para o mesmo buffer e, como o LocalStack não extrai Embedded
// Metric Format, publica as métricas das linhas (_aws) com PutMetricData.
const logBuffer = createLogBuffer(2000);
const awsConfig = { region: process.env.AWS_REGION, endpoint: process.env.AWS_ENDPOINT };
const emfAgent = createEmfAgent({
  cloudwatch: new CloudWatchClient(awsConfig),
  logs: new CloudWatchLogsClient(awsConfig),
  onEntry: entry => captureLog(entry)
});
// Memória de cada invocação (runtime-metrics.mjs): uma linha só de métrica por
// invocação; no buffer de 2000 linhas ela empurraria os logs de verdade para fora
const isRuntimeMetrics = entry => entry.event === 'RUNTIME_METRICS';
function captureLog(entry) {
  if (!isRuntimeMetrics(entry)) logBuffer.capture(entry);
}
for (const method of ['log', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (first, ...rest) => {
    const entry = parseLogLine(first);
    if (entry) {
      captureLog(entry);
      emfAgent.capture(entry);
      // Vai para o CloudWatch (agente EMF), não para o terminal
      if (isRuntimeMetrics(entry)) return;
    }
    original(first, ...rest);
  };
}

// Defeito do LocalStack sob carga (cache de tabelas corrompido): avisa no
// terminal em vez de deixar compras, reservas e SLOs falhando em silêncio
const localstackHealth = createLocalstackHealth({
  // Uma página só (queryItems seguiria todas)
  probe: () => docClient.send(new QueryCommand({
    TableName: tables.sagas,
    IndexName: SAGAS_BY_DAY_INDEX,
    KeyConditionExpression: 'dayShard = :dayShard',
    ExpressionAttributeValues: { ':dayShard': dayShardsInWindow(Date.now(), Date.now())[0] },
    Limit: 1
  }))
});

// Na AWS a varredura de sagas paradas é agendada a cada 5 min (ReconcileSagas
// no template.yaml); aqui roda a cada minuto pela mesma ação do orquestrador
function startSagaReconciler(intervalMs = 60 * 1000) {
  const timer = setInterval(() => {
    handlers.saga({ action: 'reconcileStuckSagas', input: {} }).catch(() => {
      // Já registrado pela ação (ACTION_FAILED); a próxima rodada tenta de novo
    });
  }, intervalMs);
  timer.unref();
}

// Mesmo roteamento do template.yaml
function routeFor(pathname) {
  const [, first] = pathname.split('/');
  if (first === 'products') return 'products';
  if (first === 'orders') return 'orders';
  if (first === 'stock') return 'stock';
  if (first === 'saga' || first === 'sagas') return 'saga';
  return 'gateway';
}

// Bem acima de qualquer body da API (o maior é o POST /products)
const MAX_BODY_BYTES = 1024 * 1024;

class PayloadTooLargeError extends Error {}

// Junta os Buffers antes de decodificar: concatenar chunk a chunk como string
// quebraria um caractere UTF-8 dividido entre dois chunks
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      // Acima do limite rejeita na hora e só descarta o resto, sem acumular
      if (size > MAX_BODY_BYTES) return reject(new PayloadTooLargeError(`Body maior que ${MAX_BODY_BYTES} bytes`));
      chunks.push(chunk);
    });
    req.on('end', () => resolve(size ? Buffer.concat(chunks).toString('utf8') : null));
    req.on('error', reject);
  });
}

// Evento no formato payload 2.0 do HttpApi
function buildEvent({ method, url, headers = {}, body = null }) {
  return {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    queryStringParameters: Object.fromEntries(url.searchParams),
    headers,
    requestContext: { stage: '$default', http: { method, path: url.pathname } },
    body,
    isBase64Encoded: false
  };
}

function send(res, statusCode, headers, body) {
  const merged = { ...CORS_HEADERS, ...headers };
  // Os handlers devolvem os headers de CORS da AWS; aqui a origem é decidida pelo servidor
  delete merged['Access-Control-Allow-Origin'];
  if (ALLOWED_ORIGIN) merged['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  res.writeHead(statusCode, merged);
  res.end(body);
}

const DASHBOARD_DIR = path.join(ROOT, 'dashboard');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

// Arquivo do dashboard para o caminho pedido: '/' é o index; os assets ficam em
// /dashboard/*. Só serve o que está dentro de dashboard/ e tem tipo conhecido
function dashboardFile(pathname) {
  if (pathname === '/' || pathname === '/index.html') return path.join(DASHBOARD_DIR, 'index.html');
  if (!pathname.startsWith('/dashboard/')) return null;
  let relative;
  try {
    relative = decodeURIComponent(pathname.slice('/dashboard/'.length));
  } catch {
    return null;
  }
  const file = path.resolve(DASHBOARD_DIR, relative);
  return file.startsWith(DASHBOARD_DIR + path.sep) && STATIC_TYPES[path.extname(file)] ? file : null;
}

// Host sem a porta: 'localhost:3001' -> 'localhost', '[::1]:3001' -> '[::1]'
function hostname(hostHeader = '') {
  return hostHeader.replace(/:\d+$/, '').toLowerCase();
}

const server = http.createServer(async (req, res) => {
  // Sem chave de admin o servidor só escuta em loopback; um Host de fora indica
  // DNS rebinding (um site resolvendo o próprio domínio para 127.0.0.1)
  if (!ADMIN_AUTH_ENABLED && !LOOPBACK_HOSTS.has(hostname(req.headers.host))) {
    return send(res, 403, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Host não permitido' }));
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    return send(res, 204, {}, '');
  }

  // O dashboard é servido pelo próprio servidor (evita problemas de CORS com file://)
  const staticFile = req.method === 'GET' && dashboardFile(url.pathname);
  if (staticFile) {
    let body;
    try {
      body = fs.readFileSync(staticFile);
    } catch {
      return send(res, 404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Not found' }));
    }
    // no-store: o navegador nunca reaproveita uma versão antiga do dashboard
    return send(res, 200, { 'Content-Type': STATIC_TYPES[path.extname(staticFile)], 'Cache-Control': 'no-store' }, body);
  }

  if (ADMIN_AUTH_ENABLED && isAdminRoute(req.method, url.pathname) && !(await isAuthorizedAdmin(req.headers))) {
    return send(res, 401, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Unauthorized: X-Api-Key inválida ou ausente' }));
  }

  if (req.method === 'GET' && url.pathname === '/logs') {
    const logs = logBuffer.query(Object.fromEntries(url.searchParams));
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ logs }));
  }

  const traceMatch = req.method === 'GET' && url.pathname.match(/^\/trace\/([^/]+)$/);
  if (traceMatch) {
    const correlationId = traceMatch[1];
    if (!isTraceId(correlationId)) {
      return send(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Invalid correlationId' }));
    }
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ correlationId, logs: logBuffer.trace(correlationId) }));
  }

  if (routeFor(url.pathname) === 'saga' && !process.env.SAGA_STATE_MACHINE_ARN && req.method === 'POST') {
    return send(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({
      error: `State machine ${STATE_MACHINE_NAME} não encontrada no LocalStack`,
      hint: 'Rode npm run build && npm run localstack:deploy e reinicie o local-server'
    }));
  }

  const started = Date.now();
  try {
    const event = buildEvent({ method: req.method, url, headers: req.headers, body: await readBody(req) });
    const result = await handlers[routeFor(url.pathname)](event);
    send(res, result.statusCode, result.headers || {}, result.body);
    if (process.env.LOG_LEVEL !== 'silent') {
      console.log(`${req.method} ${url.pathname} -> ${result.statusCode} (${Date.now() - started}ms)`);
    }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return send(res, 413, { 'Content-Type': 'application/json', Connection: 'close' }, JSON.stringify({ error: error.message }));
    }
    console.error(`${req.method} ${url.pathname} ->`, error);
    send(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Internal server error' }));
  }
});

if (ADMIN_API_KEY_HASH && ADMIN_API_KEY) {
  console.warn('⚠️  ADMIN_API_KEY_HASH e ADMIN_API_KEY definidas: vale só o hash, ADMIN_API_KEY é ignorada.');
}

if (!ADMIN_AUTH_ENABLED && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  console.error(`❌ HOST=${HOST} expõe o servidor na rede: defina ADMIN_API_KEY_HASH (npm run admin:hash) para proteger as rotas de admin.`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  emfAgent.start();
  localstackHealth.start();
  startSagaReconciler();
  console.log(`🛒 Dashboard em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`   LocalStack: ${process.env.AWS_ENDPOINT} (timeouts x${TIMEOUT_SCALE})`);
  console.log(process.env.SAGA_STATE_MACHINE_ARN
    ? `   Saga: ${process.env.SAGA_STATE_MACHINE_ARN}`
    : `   ⚠️  Saga não publicada: compras indisponíveis. Rode npm run build && npm run localstack:deploy`);
  console.log(ADMIN_AUTH_ENABLED
    ? `   Rotas de admin exigem X-Api-Key (${ADMIN_API_KEY_HASH ? 'ADMIN_API_KEY_HASH' : 'ADMIN_API_KEY'})`
    : '   ⚠️  Chave de admin não definida: rotas de admin abertas (só para desenvolvimento local)');
});
