#!/usr/bin/env node
/**
 * Publica a saga no LocalStack de forma permanente (para o dashboard e o
 * local-server): tabelas padrão, Lambdas `local-*` e a state machine
 * `local-purchase-saga`. Pode ser executado de novo após mudar o código.
 *
 * Uso: npm run build && npm run localstack:deploy
 */
import { clients, ensureTables, deploySaga, ensureChaosParameter, LOCAL_CHAOS_ENV } from './lib/localstack.mjs';

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
  await ensureChaosParameter(c);
  console.log(`📦 Publicando Lambdas e state machine em ${endpoint}...`);
  // Só as Lambdas local-* leem a config de caos: as dos testes e2e ficam de fora
  const { stateMachineArn, runtime } = await deploySaga(c, { prefix: LOCAL_PREFIX, tables: LOCAL_TABLES, environment: LOCAL_CHAOS_ENV });
  console.log(`✅ Saga publicada (${runtime}): ${stateMachineArn}`);
  console.log('\nPróximos passos:');
  console.log('   npm run local-server    # e abra http://localhost:3001');
  console.log('   npm run seed:local      # dev: produtos + compras de exemplo (prod: seed:local:prod)');
} catch (error) {
  console.error(`❌ ${error.message}`);
  console.error('   Verifique se o LocalStack está rodando (npm run localstack:start, com ssm em SERVICES) e se rodou npm run build.');
  process.exit(1);
}
