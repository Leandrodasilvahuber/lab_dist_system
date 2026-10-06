#!/usr/bin/env node
/**
 * Popula o catálogo (tabela de produtos) e o estoque (tabela de inventário,
 * do serviço de Stock) com os dados de src/common/seed-products.mjs.
 *
 * Dois perfis (--profile, padrão prod com --stage prod e dev nos demais):
 *  - prod: só o necessário para comprar, sem os produtos `devOnly` (o
 *    Server, que testa pagamento recusado).
 *  - dev: todos os produtos.
 * Nenhum dos dois cria compras: as sagas de exemplo do dashboard vêm do
 * npm run test:e2e:orders (scripts/e2e-sample-orders.mjs), que precisa do dev.
 *
 * Local (LocalStack): cria as tabelas que faltarem e popula.
 *   npm run seed:local          # dev
 *   npm run seed:local:prod     # prod
 *
 * AWS (tabelas criadas pelo stack SAM): apenas popula as tabelas do stage.
 *   npm run seed -- --stage dev
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
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { writeProductUnlessDeleted } from './lib/seed-product.mjs';
import { ensureTable } from './lib/tables.mjs';
import { SEED_PRODUCTS } from '../src/common/seed-products.mjs';

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

const products = SEED_PRODUCTS.filter(product => profile === 'dev' || !product.devOnly);
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

