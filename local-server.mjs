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
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SFNClient, ListStateMachinesCommand } from '@aws-sdk/client-sfn';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const STATE_MACHINE_NAME = 'local-purchase-saga';

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

const handlers = {
  products: (await import('./src/ecommerce/products/index.mjs')).handler,
  orders: (await import('./src/ecommerce/orders/index.mjs')).handler,
  payments: (await import('./src/ecommerce/payments/index.mjs')).handler,
  stock: (await import('./src/ecommerce/stock/index.mjs')).handler,
  saga: (await import('./src/ecommerce/saga-orchestrator/index.mjs')).handler,
  gateway: (await import('./src/layers/api-gateway-layer/src/routes/apiRoutes.js')).handler
};

// Mesmo roteamento do template.yaml
function routeFor(pathname) {
  const [, first] = pathname.split('/');
  if (first === 'products') return 'products';
  if (first === 'orders') return 'orders';
  if (first === 'payments') return 'payments';
  if (first === 'stock') return 'stock';
  if (first === 'saga' || first === 'sagas') return 'saga';
  return 'gateway';
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Correlation-Id'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body || null));
    req.on('error', reject);
  });
}

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, { ...CORS_HEADERS, ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    return send(res, 204, {}, '');
  }

  // O dashboard é servido pelo próprio servidor (evita problemas de CORS com file://)
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(ROOT, 'ecommerce-dashboard.html'));
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, html);
  }

  if (routeFor(url.pathname) === 'saga' && !process.env.SAGA_STATE_MACHINE_ARN && req.method === 'POST') {
    return send(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({
      error: `State machine ${STATE_MACHINE_NAME} não encontrada no LocalStack`,
      hint: 'Rode npm run build && npm run localstack:deploy e reinicie o local-server'
    }));
  }

  const started = Date.now();
  try {
    const event = {
      version: '2.0',
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers: req.headers,
      requestContext: { stage: '$default', http: { method: req.method, path: url.pathname } },
      body: await readBody(req),
      isBase64Encoded: false
    };

    const result = await handlers[routeFor(url.pathname)](event);
    send(res, result.statusCode, result.headers || {}, result.body);
    if (process.env.LOG_LEVEL !== 'silent') {
      console.log(`${req.method} ${url.pathname} -> ${result.statusCode} (${Date.now() - started}ms)`);
    }
  } catch (error) {
    console.error(`${req.method} ${url.pathname} ->`, error);
    send(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Internal server error' }));
  }
});

server.listen(PORT, () => {
  console.log(`🛒 Dashboard em http://localhost:${PORT}`);
  console.log(`   LocalStack: ${process.env.AWS_ENDPOINT}`);
  console.log(process.env.SAGA_STATE_MACHINE_ARN
    ? `   Saga: ${process.env.SAGA_STATE_MACHINE_ARN}`
    : `   ⚠️  Saga não publicada: compras indisponíveis. Rode npm run build && npm run localstack:deploy`);
});
