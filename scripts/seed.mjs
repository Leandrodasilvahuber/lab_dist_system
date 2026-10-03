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
 */
import fs from 'node:fs';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';

const args = process.argv.slice(2);
const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : null;

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
const { putItem, tables } = await import('../src/common/database.mjs');

const endpoint = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT;
const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1', ...(endpoint && { endpoint }) });

async function ensureTable(name) {
  try {
    await client.send(new DescribeTableCommand({ TableName: name }));
    return 'existe';
  } catch (error) {
    if (error.name !== 'ResourceNotFoundException') throw error;
  }

  if (!endpoint) {
    throw new Error(`Tabela ${name} não existe. Na AWS ela é criada pelo deploy (npm run deploy).`);
  }

  await client.send(new CreateTableCommand({
    TableName: name,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }]
  }));
  await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: name });
  return 'criada';
}

console.log(`🌱 Seed em ${endpoint || 'AWS (' + (process.env.AWS_REGION || 'us-east-1') + ')'}`);

for (const name of Object.values(tables)) {
  console.log(`   tabela ${name}: ${await ensureTable(name)}`);
}

const { products } = JSON.parse(fs.readFileSync(new URL('./seed-products.json', import.meta.url)));
const now = new Date().toISOString();
for (const { stock = 0, ...product } of products) {
  await putItem('products', { ...product, createdAt: now, updatedAt: now });
  await putItem('inventory', { id: product.id, name: product.name, stock, createdAt: now, updatedAt: now });
  console.log(`   ✅ ${product.id}: ${product.name} (R$ ${product.price}, estoque ${stock})`);
}

console.log(`\n${products.length} produtos gravados em ${tables.products} e ${tables.inventory}`);
