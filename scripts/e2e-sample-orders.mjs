#!/usr/bin/env node
/**
 * Compras de exemplo pela API, para o dashboard ter sagas concluídas e
 * compensadas, conferindo o resultado de cada uma. Diferente do test:e2e, roda
 * nas tabelas de verdade (as do local-server, ou do stage na AWS) e não apaga
 * nada: os dados ficam para as abas Pedidos e Desempenho.
 *
 * Tem os dois tipos de falha: o Server (pagamento recusado → estorno do
 * estoque e do pedido) e uma compra acima do estoque (falha na reserva →
 * cancela o pedido).
 *
 * As chaves de idempotência são fixas: rodar de novo não compra outra vez, só
 * confere o status das sagas que já existem.
 *
 * Pré-requisitos (local):
 *   npm run local-server
 *   npm run seed:local        # o perfil dev, que tem o produto server
 *
 * Uso:
 *   npm run test:e2e:orders
 *   npm run test:e2e:orders -- --api https://xxx.execute-api.us-east-1.amazonaws.com
 */
import { mapLimit } from './lib/pool.mjs';
import { LOCAL_MAX_CONCURRENCY } from './lib/localstack.mjs';

const SAMPLE_ORDERS = [
  { productId: 'apple', quantity: 2, expected: 'COMPLETED' },
  { productId: 'banana', quantity: 3, expected: 'COMPLETED' },
  { productId: 'grape', quantity: 1, expected: 'COMPLETED' },
  { productId: 'server', quantity: 1, expected: 'COMPENSATED' },
  { productId: 'orange', quantity: 2, expected: 'COMPLETED' },
  { productId: 'orange', quantity: 999, expected: 'COMPENSATED' },
  { productId: 'banana', quantity: 1, expected: 'COMPLETED' }
];

const args = process.argv.slice(2);
const apiArg = args.includes('--api') ? args[args.indexOf('--api') + 1] : null;
const api = (apiArg || 'http://localhost:3001').replace(/\/$/, '');

const request = async (path, init) => {
  const response = await fetch(api + path, init);
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

try {
  await request('/health');
} catch {
  console.error(`❌ API ${api} fora do ar. Suba o local-server (npm run local-server) ou passe --api`);
  process.exit(1);
}

const productIds = [...new Set(SAMPLE_ORDERS.map(order => order.productId))];
const missing = [];
for (const id of productIds) {
  const { status } = await request(`/products/${encodeURIComponent(id)}`);
  if (status !== 200) missing.push(id);
}
if (missing.length) {
  console.error(`❌ Produtos ausentes: ${missing.join(', ')}. Rode npm run seed:local (o perfil prod não tem o server)`);
  process.exit(1);
}

// A saga roda em segundo plano; espera sair de RUNNING/COMPENSATING
const waitSagaDone = async (sagaId, timeoutMs = 5 * 60 * 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await request(`/saga/${encodeURIComponent(sagaId)}`);
    if (data.status && !['RUNNING', 'COMPENSATING'].includes(data.status)) return data.status;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return 'TIMEOUT';
};

console.log(`🧾 Compras de exemplo em ${api}`);
let created = 0;
let existing = 0;
let failed = 0;
// No máximo LOCAL_MAX_CONCURRENCY ao mesmo tempo: as 7 de uma vez sobem
// dezenas de contêineres no LocalStack (scripts/lib/localstack.mjs)
await mapLimit(SAMPLE_ORDERS, LOCAL_MAX_CONCURRENCY, async ({ expected, ...order }, index) => {
  const label = `${order.productId} x${order.quantity}`;
  try {
    const { status, data } = await request('/saga/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `seed-sample-order-${index + 1}` },
      body: JSON.stringify(order)
    });
    // 202: saga nova; 200: a chave já tinha saga (idempotência), nada foi comprado
    if (status !== 202 && status !== 200) {
      failed++;
      console.log(`  ✖ ${label}: HTTP ${status}${data.error ? ` (${data.error})` : ''}`);
      return;
    }
    if (status === 202) created++;
    else existing++;
    const final = await waitSagaDone(data.sagaId);
    const ok = final === expected;
    if (!ok) failed++;
    console.log(`  ${ok ? '✔' : '✖'} ${label}: ${final}${ok ? '' : ` (esperado ${expected})`}${status === 200 ? ' (já existia)' : ''}`);
  } catch (error) {
    failed++;
    console.log(`  ✖ ${label}: ${error.message}`);
  }
});

console.log(`\n${created} compras enviadas, ${existing} já existiam`);
if (failed) {
  console.log(`${failed} DE ${SAMPLE_ORDERS.length} CENÁRIOS FALHARAM`);
  process.exit(1);
}
console.log('TODOS OS CENÁRIOS PASSARAM');
