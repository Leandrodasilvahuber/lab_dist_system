#!/usr/bin/env node
/**
 * Grava `dayShard` (chave do SagasByDayIndex) nas sagas criadas antes do
 * índice. Sem isso elas ficam fora da aba SLOs até saírem da janela (até 7 dias).
 * Rodar uma vez depois do deploy que cria o índice; repetir não muda nada.
 *
 * Local (LocalStack):  npm run backfill:sagas:local
 * AWS:                 npm run backfill:sagas -- --stage dev
 */
import { sagaDayShard } from '../src/common/saga-day-index.mjs';

const args = process.argv.slice(2);
const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : null;
if (stage) process.env.SAGAS_TABLE = `${stage}-Sagas`;

// Import dinâmico: database.mjs lê as variáveis de ambiente ao carregar
const { scanPage, updateItem, tables } = await import('../src/common/database.mjs');

let scanned = 0;
let updated = 0;
let startKey;
do {
  const { items, lastKey } = await scanPage('sagas', { startKey });
  scanned += items.length;
  for (const saga of items) {
    if (saga.dayShard || !saga.createdAt) continue;
    try {
      await updateItem('sagas', { id: saga.id }, 'SET dayShard = :dayShard',
        { ':dayShard': sagaDayShard(saga.id, saga.createdAt) },
        { conditionExpression: 'attribute_not_exists(dayShard)' });
      updated++;
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  startKey = lastKey;
} while (startKey);

console.log(`✅ ${tables.sagas}: ${scanned} sagas lidas, ${updated} receberam dayShard`);
