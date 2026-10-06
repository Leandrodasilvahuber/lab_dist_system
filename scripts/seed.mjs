#!/usr/bin/env node
/**
 * Popula o catálogo (tabela de produtos) e o estoque (tabela de inventário,
 * do serviço de Stock) com os dados de scripts/seed-products.json.
 *
 * Dois perfis (--profile, padrão prod com --stage prod e dev nos demais):
 *  - prod: só o necessário para comprar, catálogo e estoque, sem os produtos
 *    `devOnly` (o Server, que testa pagamento recusado). Não cria execuções,
 *    logs nem métricas.
 *  - dev: todos os produtos e, depois, as compras de exemplo (SAMPLE_ORDERS)
 *    pela API, para o dashboard ter sagas concluídas e compensadas. As chaves
 *    de idempotência são fixas: rodar de novo não compra outra vez. Precisa da
 *    API no ar (--api, padrão http://localhost:3001 no local; na AWS, a URL do
 *    output ApiGatewayUrl). --no-orders grava só o catálogo.
 *
 * Local (LocalStack): cria as tabelas que faltarem e popula.
 *   npm run seed:local          # dev (com o local-server rodando, para as compras)
 *   npm run seed:local:prod     # prod
 *
 * AWS (tabelas criadas pelo stack SAM): apenas popula as tabelas do stage.
 *   npm run seed -- --stage dev --api https://xxx.execute-api.us-east-1.amazonaws.com
 *   npm run seed -- --stage prod
 *
 * Os nomes das tabelas seguem as mesmas variáveis de src/common/database.mjs
 * (PRODUCTS_TABLE, ORDERS_TABLE...). Com --stage, viram <stage>-Products etc.
 *
 * Só grava o que ainda não existe: rodar de novo numa stack em uso não volta
 * o estoque ao valor do seed (as reservas ativas já debitaram unidades, que
 * contariam duas vezes) nem recria produto excluído. Para sobrescrever
 * catálogo e estoque com o seed, passe --reset.
 */
import fs from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { writeProductUnlessDeleted } from './lib/seed-product.mjs';
import { ensureTable } from './lib/tables.mjs';
import { mapLimit } from './lib/pool.mjs';
import { LOCAL_MAX_CONCURRENCY } from './lib/localstack.mjs';

const args = process.argv.slice(2);
const option = name => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : null);
const stage = option('stage');
const reset = args.includes('--reset');
const profile = option('profile') || (stage === 'prod' ? 'prod' : 'dev');
if (!['dev', 'prod'].includes(profile)) {
  console.error(`❌ --profile ${profile}: use dev ou prod`);
  process.exit(1);
}

if (stage) {
  Object.assign(process.env, {
    PRODUCTS_TABLE: `${stage}-Products`,
    ORDERS_TABLE: `${stage}-Orders`,
    PAYMENTS_TABLE: `${stage}-Payments`,
    STOCK_RESERVATIONS_TABLE: `${stage}-StockReservations`,
    INVENTORY_TABLE: `${stage}-Inventory`,
    SAGAS_TABLE: `${stage}-Sagas`
  });
}

// Import dinâmico: database.mjs lê as variáveis de ambiente ao carregar
const db = await import('../src/common/database.mjs');
const { putItem, putItemIfNotExists, tables } = db;

const endpoint = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT;
const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1', ...(endpoint && { endpoint }) });

console.log(`🌱 Seed ${profile} em ${endpoint || 'AWS (' + (process.env.AWS_REGION || 'us-east-1') + ')'}`);

// Localmente cria o que faltar; na AWS as tabelas vêm do stack e só são conferidas
for (const [logical, name] of Object.entries(tables)) {
  console.log(`   tabela ${name}: ${await ensureTable(client, logical, name, { create: Boolean(endpoint) })}`);
}

const catalog = JSON.parse(fs.readFileSync(new URL('./seed-products.json', import.meta.url))).products;
const products = catalog.filter(product => profile === 'dev' || !product.devOnly);
const now = new Date().toISOString();
// Com --reset sobrescreve; sem ele, grava só o que falta (true se gravou)
const write = (table, item) => reset ? putItem(table, item).then(() => true) : putItemIfNotExists(table, item);

// Com --reset sobrescreve; sem ele, não recria produto excluído (ver lib/seed-product.mjs)
const writeProduct = product => reset
  ? putItem('products', product).then(() => 'written')
  : writeProductUnlessDeleted(db, product);

let written = 0;
let deleted = 0;
for (const { stock = 0, ...product } of products) {
  delete product.devOnly; // só decide o perfil, não vai para a tabela
  const productResult = await writeProduct({ ...product, createdAt: now, updatedAt: now });
  if (productResult === 'deleted') {
    deleted++;
    console.log(`   🗑️  ${product.id}: ${product.name} (excluído, mantido; --reset recria)`);
    continue;
  }
  const wroteProduct = productResult === 'written';
  const wroteStock = await write('inventory', { id: product.id, name: product.name, stock, createdAt: now, updatedAt: now });
  if (wroteProduct || wroteStock) written++;
  const [icon, result] = wroteProduct && wroteStock ? ['✅', `estoque ${stock}`]
    : wroteProduct ? ['➕', 'produto gravado; estoque já existia, mantido']
      : wroteStock ? ['➕', `produto já existia; estoque ${stock}`]
        : ['⏭️ ', 'já existia, mantido'];
  console.log(`   ${icon} ${product.id}: ${product.name} (R$ ${product.price}, ${result})`);
}

console.log(`\n${written} de ${products.length} produtos gravados em ${tables.products} e ${tables.inventory}` +
  (deleted ? `, ${deleted} excluído(s) mantido(s)` : '') +
  (reset || written + deleted === products.length ? '' : ' (use --reset para sobrescrever com o seed)'));

if (profile === 'dev' && !args.includes('--no-orders')) await seedSampleOrders();

// Compras de exemplo, com os dois tipos de falha para a aba Desempenho:
// concluídas, uma do Server (pagamento recusado → estorno do estoque e do
// pedido) e uma acima do estoque (falha na reserva → cancela o pedido)
async function seedSampleOrders() {
  const SAMPLE_ORDERS = [
    { productId: 'apple', quantity: 2 },
    { productId: 'banana', quantity: 3 },
    { productId: 'grape', quantity: 1 },
    { productId: 'server', quantity: 1 },
    { productId: 'orange', quantity: 2 },
    { productId: 'orange', quantity: 999 },
    { productId: 'banana', quantity: 1 }
  ];
  const api = (option('api') || (endpoint ? 'http://localhost:3001' : '')).replace(/\/$/, '');
  if (!api) {
    console.log('\n⚠️  Compras de exemplo não enviadas: passe --api <ApiGatewayUrl> (ou --no-orders)');
    return;
  }
  const request = async (path, init) => {
    const response = await fetch(api + path, init);
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
  try {
    await request('/health');
  } catch {
    console.log(`\n⚠️  Compras de exemplo não enviadas: API ${api} fora do ar. Suba o local-server e rode o seed de novo`);
    return;
  }

  // A próxima compra de exemplo só sai depois que a anterior termina
  const waitSagaDone = async (sagaId, timeoutMs = 5 * 60 * 1000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { data } = await request(`/saga/${encodeURIComponent(sagaId)}`);
      if (data.status && !['RUNNING', 'COMPENSATING'].includes(data.status)) return data.status;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return 'TIMEOUT';
  };

  console.log(`\n🧾 Compras de exemplo em ${api}`);
  let created = 0;
  let existing = 0;
  // No máximo LOCAL_MAX_CONCURRENCY ao mesmo tempo: as 7 de uma vez sobem
  // dezenas de contêineres no LocalStack (scripts/lib/localstack.mjs)
  await mapLimit(SAMPLE_ORDERS, LOCAL_MAX_CONCURRENCY, async (order, index) => {
    const label = `${order.productId} x${order.quantity}`;
    try {
      const { status, data } = await request('/saga/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `seed-sample-order-${index + 1}` },
        body: JSON.stringify(order)
      });
      // 202: saga nova; 200: a chave já tinha saga (idempotência), nada foi comprado
      if (status === 202) {
        created++;
        console.log(`   ✅ ${label}: ${await waitSagaDone(data.sagaId)}`);
      } else if (status === 200) existing++;
      else console.warn(`   ⚠️  ${label}: HTTP ${status}${data.error ? ` (${data.error})` : ''}`);
    } catch (error) {
      console.warn(`   ⚠️  ${label}: ${error.message}`);
    }
  });
  if (existing) console.log(`   ⏭️  ${existing} compras de exemplo já existiam (ignoradas pela idempotência)`);
  console.log(`${created} compras de exemplo enviadas`);
}
