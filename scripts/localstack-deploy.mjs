#!/usr/bin/env node
/**
 * Publica a saga no LocalStack de forma permanente (para o dashboard e o
 * local-server): tabelas padrão, Lambdas `local-*` e a state machine
 * `local-purchase-saga`. Pode ser executado de novo após mudar o código.
 *
 * Uso: npm run build && npm run localstack:deploy
 */
import { clients, ensureTables, deploySaga } from './lib/localstack.mjs';

const endpoint = process.env.LOCALSTACK_ENDPOINT || 'http://localhost:4566';
export const LOCAL_PREFIX = 'local';
export const LOCAL_TABLES = {
  PRODUCTS_TABLE: 'products',
  ORDERS_TABLE: 'orders',
  PAYMENTS_TABLE: 'payments',
  STOCK_RESERVATIONS_TABLE: 'stock-reservations',
  INVENTORY_TABLE: 'inventory',
  SAGAS_TABLE: 'sagas'
};

const c = clients(endpoint);
try {
  await ensureTables(c, LOCAL_TABLES);
  console.log(`📦 Publicando Lambdas e state machine em ${endpoint}...`);
  const { stateMachineArn, runtime } = await deploySaga(c, { prefix: LOCAL_PREFIX, tables: LOCAL_TABLES });
  console.log(`✅ Saga publicada (${runtime}): ${stateMachineArn}`);
  console.log('\nPróximos passos:');
  console.log('   npm run seed:local      # produtos de exemplo (se ainda não rodou)');
  console.log('   npm run local-server    # e abra http://localhost:3001');
} catch (error) {
  console.error(`❌ ${error.message}`);
  console.error('   Verifique se o LocalStack está rodando (npm run localstack:start) e se rodou npm run build.');
  process.exit(1);
}
