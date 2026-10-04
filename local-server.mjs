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
 *   npm run localstack:start && npm run seed:local
 *   npm run build && npm run localstack:deploy
 *   npm run local-server        # abra http://localhost:3001
 *
 * Ao subir com a saga publicada, envia algumas compras de exemplo (SAMPLE_ORDERS)
 * para o dashboard não começar vazio. Isso acontece em toda subida, mas as chaves
 * de idempotência são fixas: só viram pedidos novos enquanto essas sagas não
 * existem na tabela Sagas (1ª subida após o deploy ou LocalStack recriado).
 * SAMPLE_ORDERS=false desliga.
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

// Os serviços leem a configuração ao carregar, então ela vem antes dos imports dinâmicos
process.env.AWS_ENDPOINT ||= 'http://localhost:4566';
process.env.AWS_REGION ||= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ||= 'test';
process.env.AWS_SECRET_ACCESS_KEY ||= 'test';

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
// GET /alarms lista só os alarmes do ambiente local (mesmo padrão de nome do template.yaml)
process.env.ALARM_PREFIX ||= 'local-ecommerce-';
// GET /dlq lê a DLQ local (criada pelo npm run test:e2e:errors)
process.env.DLQ_NAME ||= 'local-ProductEventsDlq';

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
  onEntry: entry => logBuffer.capture(entry)
});
for (const method of ['log', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (first, ...rest) => {
    const entry = parseLogLine(first);
    if (entry) {
      logBuffer.capture(entry);
      emfAgent.capture(entry);
    }
    original(first, ...rest);
  };
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

// Compras de exemplo, com os dois tipos de falha para a aba Desempenho:
// concluídas, uma do Server (pagamento recusado → estorno do estoque e do
// pedido) e uma acima do estoque (falha na reserva → cancela o pedido)
const SAMPLE_ORDERS = [
  { productId: 'apple', quantity: 2 },
  { productId: 'banana', quantity: 3 },
  { productId: 'grape', quantity: 1 },
  { productId: 'server', quantity: 1 },
  { productId: 'orange', quantity: 2 },
  { productId: 'orange', quantity: 999 },
  { productId: 'banana', quantity: 1 }
];

async function seedSampleOrders() {
  let created = 0;
  let existing = 0;
  for (const [index, order] of SAMPLE_ORDERS.entries()) {
    const event = buildEvent({
      method: 'POST',
      url: new URL('/saga/execute', `http://localhost:${PORT}`),
      headers: { 'content-type': 'application/json', 'idempotency-key': `seed-sample-order-${index + 1}` },
      body: JSON.stringify(order)
    });
    try {
      const result = await handlers.saga(event);
      // 202: saga nova; 200: a chave já tinha saga (idempotência), nada foi comprado
      if (result.statusCode === 202) created++;
      else if (result.statusCode === 200) existing++;
      else {
        const hint = result.statusCode === 404 ? ' (rodou npm run seed:local?)' : '';
        console.warn(`   ⚠️  Compra de exemplo ${order.productId}: HTTP ${result.statusCode}${hint}`);
      }
    } catch (error) {
      console.warn(`   ⚠️  Compra de exemplo ${order.productId}: ${error.message}`);
    }
  }
  if (process.env.LOG_LEVEL === 'silent') return;
  if (created) console.log(`   🧾 ${created} compras de exemplo disparadas`);
  if (existing) console.log(`   🧾 ${existing} compras de exemplo já existiam (ignoradas pela idempotência)`);
}

function send(res, statusCode, headers, body) {
  const merged = { ...CORS_HEADERS, ...headers };
  // Os handlers devolvem os headers de CORS da AWS; aqui a origem é decidida pelo servidor
  delete merged['Access-Control-Allow-Origin'];
  if (ALLOWED_ORIGIN) merged['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  res.writeHead(statusCode, merged);
  res.end(body);
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
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(ROOT, 'ecommerce-dashboard.html'));
    // no-store: o navegador nunca reaproveita uma versão antiga do dashboard
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, html);
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
  console.log(`🛒 Dashboard em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`   LocalStack: ${process.env.AWS_ENDPOINT}`);
  console.log(process.env.SAGA_STATE_MACHINE_ARN
    ? `   Saga: ${process.env.SAGA_STATE_MACHINE_ARN}`
    : `   ⚠️  Saga não publicada: compras indisponíveis. Rode npm run build && npm run localstack:deploy`);
  console.log(ADMIN_AUTH_ENABLED
    ? `   Rotas de admin exigem X-Api-Key (${ADMIN_API_KEY_HASH ? 'ADMIN_API_KEY_HASH' : 'ADMIN_API_KEY'})`
    : '   ⚠️  Chave de admin não definida: rotas de admin abertas (só para desenvolvimento local)');
  if (process.env.SAGA_STATE_MACHINE_ARN && process.env.SAMPLE_ORDERS !== 'false') seedSampleOrders();
});
