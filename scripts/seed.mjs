#!/usr/bin/env node
/**
 * Popula o catálogo (tabela de produtos) e o estoque (tabela de inventário,
 * do serviço de Stock) com os dados de scripts/seed-products.json.
 *
 * Local (LocalStack): cria as tabelas que faltarem e popula.
 *   npm run seed:local
 *
 * AWS (tabelas criadas pelo stack SAM): apenas popula as tabelas do stage.
 *   npm run seed -- --stage dev
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
import { ensureTable } from './lib/tables.mjs';

const args = process.argv.slice(2);
const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : null;
const reset = args.includes('--reset');

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
const { putItem, putItemIfNotExists, tables } = await import('../src/common/database.mjs');

const endpoint = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT;
const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1', ...(endpoint && { endpoint }) });

console.log(`🌱 Seed em ${endpoint || 'AWS (' + (process.env.AWS_REGION || 'us-east-1') + ')'}`);

// Localmente cria o que faltar; na AWS as tabelas vêm do stack e só são conferidas
for (const [logical, name] of Object.entries(tables)) {
  console.log(`   tabela ${name}: ${await ensureTable(client, logical, name, { create: Boolean(endpoint) })}`);
}

const { products } = JSON.parse(fs.readFileSync(new URL('./seed-products.json', import.meta.url)));
const now = new Date().toISOString();
// Com --reset sobrescreve; sem ele, grava só o que falta (true se gravou)
const write = (table, item) => reset ? putItem(table, item).then(() => true) : putItemIfNotExists(table, item);
let written = 0;
for (const { stock = 0, ...product } of products) {
  const wroteProduct = await write('products', { ...product, createdAt: now, updatedAt: now });
  const wroteStock = await write('inventory', { id: product.id, name: product.name, stock, createdAt: now, updatedAt: now });
  if (wroteProduct || wroteStock) written++;
  const [icon, result] = wroteProduct && wroteStock ? ['✅', `estoque ${stock}`]
    : wroteProduct ? ['➕', 'produto gravado; estoque já existia, mantido']
      : wroteStock ? ['➕', `produto já existia; estoque ${stock}`]
        : ['⏭️ ', 'já existia, mantido'];
  console.log(`   ${icon} ${product.id}: ${product.name} (R$ ${product.price}, ${result})`);
}

console.log(`\n${written} de ${products.length} produtos gravados em ${tables.products} e ${tables.inventory}` +
  (reset || written === products.length ? '' : ' (os demais já existiam: use --reset para sobrescrever)'));
