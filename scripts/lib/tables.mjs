/**
 * Criação das tabelas fora da AWS (LocalStack), com os mesmos índices do
 * template.yaml. Usado por scripts/seed.mjs e scripts/lib/localstack.mjs.
 */
import {
  CreateTableCommand, DescribeTableCommand, UpdateTableCommand, waitUntilTableExists
} from '@aws-sdk/client-dynamodb';

// Índices por nome lógico da tabela (as chaves de `tables` em src/common/database.mjs)
const INDEXES = {
  stockreservations: [{
    IndexName: 'ActiveReservationsIndex',
    KeySchema: [{ AttributeName: 'activeProductId', KeyType: 'HASH' }],
    Projection: { ProjectionType: 'ALL' }
  }],
  sagas: [{
    IndexName: 'SagasByDayIndex',
    KeySchema: [{ AttributeName: 'dayShard', KeyType: 'HASH' }, { AttributeName: 'createdAt', KeyType: 'RANGE' }],
    Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['status', 'updatedAt'] }
  }]
};

// 'STOCK_RESERVATIONS_TABLE' -> 'stockreservations'
export function logicalName(envKey) {
  return envKey.replace(/_TABLE$/, '').replace(/_/g, '').toLowerCase();
}

/**
 * @returns {import('@aws-sdk/client-dynamodb').AttributeDefinition[]}
 */
function attributeDefinitions(indexes) {
  const names = new Set(['id', ...indexes.flatMap(i => i.KeySchema.map(k => k.AttributeName))]);
  return [...names].map(AttributeName => ({ AttributeName, AttributeType: 'S' }));
}

/**
 * Garante que a tabela exista com os índices esperados. Tabelas criadas por
 * versões anteriores (sem o índice) ganham o índice que falta.
 * Retorna 'criada', 'existe' ou 'índice criado'.
 */
export async function ensureTable(client, logical, TableName, { create = true } = {}) {
  const indexes = INDEXES[logical] || [];
  let table;
  try {
    ({ Table: table } = await client.send(new DescribeTableCommand({ TableName })));
  } catch (error) {
    if (error.name !== 'ResourceNotFoundException') throw error;
  }

  if (!table) {
    if (!create) {
      throw new Error(`Tabela ${TableName} não existe. Na AWS ela é criada pelo deploy (npm run deploy).`);
    }
    await client.send(new CreateTableCommand({
      TableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: attributeDefinitions(indexes),
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      ...(indexes.length && { GlobalSecondaryIndexes: indexes })
    }));
    await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName });
    return 'criada';
  }

  const existing = new Set((table.GlobalSecondaryIndexes || []).map(i => i.IndexName));
  const missing = indexes.filter(i => !existing.has(i.IndexName));
  if (!missing.length) return 'existe';
  if (!create) {
    throw new Error(`Tabela ${TableName} sem o índice ${missing[0].IndexName}. Atualize o stack (npm run deploy).`);
  }

  for (const index of missing) {
    await client.send(new UpdateTableCommand({
      TableName,
      AttributeDefinitions: attributeDefinitions(indexes),
      GlobalSecondaryIndexUpdates: [{ Create: index }]
    }));
  }

  // Consultas no índice só funcionam depois que ele fica ACTIVE
  for (let i = 0; i < 60; i++) {
    const { Table } = await client.send(new DescribeTableCommand({ TableName }));
    if ((Table.GlobalSecondaryIndexes || []).every(idx => idx.IndexStatus === 'ACTIVE')) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return 'índice criado';
}
