import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
  DeleteCommand,
  TransactWriteCommand
} from '@aws-sdk/lib-dynamodb';

// Endpoint customizado só é usado quando definido (LocalStack / DynamoDB Local).
// Na AWS a variável não existe e o SDK usa o endpoint padrão da região.
const endpoint = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT;

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1',
  ...(endpoint && { endpoint })
});

const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true }
});

// Nome físico de cada tabela, configurável por variável de ambiente.
// No deploy o template deve injetar os nomes (ex.: dev-Products).
const tables = {
  products: process.env.PRODUCTS_TABLE || 'products',
  orders: process.env.ORDERS_TABLE || 'orders',
  payments: process.env.PAYMENTS_TABLE || 'payments',
  stockreservations: process.env.STOCK_RESERVATIONS_TABLE || 'stock-reservations',
  sagas: process.env.SAGAS_TABLE || 'sagas'
};

// Aceita o nome lógico em qualquer caixa ('products', 'Products', 'StockReservations')
function getTable(tableType) {
  return tables[String(tableType).toLowerCase()] || tableType;
}

async function putItem(tableType, item) {
  await docClient.send(new PutCommand({
    TableName: getTable(tableType),
    Item: item
  }));
  return item;
}

/**
 * Grava o item somente se a chave ainda não existir.
 * Retorna true se gravou, false se já existia (útil para idempotência).
 */
async function putItemIfNotExists(tableType, item, keyName = 'id') {
  try {
    await docClient.send(new PutCommand({
      TableName: getTable(tableType),
      Item: item,
      ConditionExpression: 'attribute_not_exists(#key)',
      ExpressionAttributeNames: { '#key': keyName }
    }));
    return true;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

async function getItem(tableType, key) {
  const { Item } = await docClient.send(new GetCommand({
    TableName: getTable(tableType),
    Key: key
  }));
  return Item;
}

async function queryItems(tableType, queryParams) {
  const { Items } = await docClient.send(new QueryCommand({
    TableName: getTable(tableType),
    ...queryParams
  }));
  return Items || [];
}

async function updateItem(tableType, key, updateExpression, expressionAttributeValues, options = {}) {
  const { Attributes } = await docClient.send(new UpdateCommand({
    TableName: getTable(tableType),
    Key: key,
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: options.returnValues || 'UPDATED_NEW',
    ...(options.conditionExpression && { ConditionExpression: options.conditionExpression }),
    ...(options.expressionAttributeNames && { ExpressionAttributeNames: options.expressionAttributeNames })
  }));
  return Attributes;
}

/**
 * Executa várias escritas de forma atômica (tudo ou nada).
 * Cada operação usa nomes lógicos de tabela: { Put|Update|ConditionCheck|Delete: { table, ... } }
 */
async function transactWrite(operations) {
  const TransactItems = operations.map(op => {
    const [type, { table, ...params }] = Object.entries(op)[0];
    return { [type]: { TableName: getTable(table), ...params } };
  });
  await docClient.send(new TransactWriteCommand({ TransactItems }));
}

async function scanItems(tableType) {
  const items = [];
  let ExclusiveStartKey;

  // Percorre todas as páginas do scan (limite de 1MB por chamada)
  do {
    const result = await docClient.send(new ScanCommand({
      TableName: getTable(tableType),
      ExclusiveStartKey
    }));
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

async function deleteItem(tableType, key) {
  await docClient.send(new DeleteCommand({
    TableName: getTable(tableType),
    Key: key
  }));
}

// Database class wrapper for testing
export class Database {
  constructor() {
    this.docClient = docClient;
  }

  async putItem(tableType, item) {
    return putItem(tableType, item);
  }

  async getItem(tableType, key) {
    return getItem(tableType, key);
  }

  async queryItems(tableType, queryParams) {
    return queryItems(tableType, queryParams);
  }

  async putItemIfNotExists(tableType, item, keyName) {
    return putItemIfNotExists(tableType, item, keyName);
  }

  async updateItem(tableType, key, updateExpression, expressionAttributeValues, options) {
    return updateItem(tableType, key, updateExpression, expressionAttributeValues, options);
  }

  async transactWrite(operations) {
    return transactWrite(operations);
  }

  async scanItems(tableType) {
    return scanItems(tableType);
  }

  async deleteItem(tableType, key) {
    return deleteItem(tableType, key);
  }
}

export { docClient, tables };
export default Database;
export { putItem, putItemIfNotExists, getItem, queryItems, updateItem, transactWrite, scanItems, deleteItem };
export { getTable };
