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
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { awsClientConfig, scaled } from './aws-client.mjs';
import { MAX_PAGE_SIZE } from './pagination.mjs';

// Os três clientes abaixo dividem os mesmos sockets (um pool por container, não
// três). maxSockets cobre uma página inteira de listagem (MAX_PAGE_SIZE) com uma
// consulta por item em paralelo: com o padrão do SDK (50) metade esperaria na
// fila, e a espera pelo socket não entra no requestTimeout
export const MAX_SOCKETS = MAX_PAGE_SIZE;
const agentOptions = { keepAlive: true, maxSockets: MAX_SOCKETS };
const handlerOptions = { httpAgent: new HttpAgent(agentOptions), httpsAgent: new HttpsAgent(agentOptions) };

// Endpoint customizado só é usado quando definido (LocalStack / DynamoDB Local).
// Na AWS a variável não existe e o SDK usa o endpoint padrão da região.
function createDocClient(options) {
  return DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfig('DYNAMODB_ENDPOINT', { ...options, handlerOptions })), {
    marshallOptions: { removeUndefinedValues: true }
  });
}

const docClient = createDocClient();

// Uma tentativa só (`retry: false`), em dois casos:
// - escrita que não é idempotente (ex.: `stock = stock + :delta`): depois de
//   um timeout do cliente a escrita pode ter sido aplicada, e o retry do SDK a
//   aplicaria de novo; quem repete decide (o cliente HTTP)
// - leitura acessória que degrada se falhar (reservas no GET /stock): o retry
//   só gastaria o orçamento de tempo da Lambda
const noRetryDocClient = createDocClient({ maxAttempts: 1 });

// Página de Scan das listagens (GET /products, /stock, /orders, /sagas): lê
// muito mais que um getItem, e com 3s responderia 503 sob carga. Uma tentativa
// só. Pior caso do GET /stock (timeout 15s): Scan 1s + 5s, depois as reservas
// de todos os itens em paralelo, uma tentativa de 1s + 3s = 10s (na AWS; no
// LocalStack tudo escala com TIMEOUT_SCALE)
export const SCAN_TIMEOUT_MS = scaled(5000);
const scanDocClient = createDocClient({ requestTimeout: SCAN_TIMEOUT_MS, maxAttempts: 1 });

// Nome físico de cada tabela, configurável por variável de ambiente.
// No deploy o template deve injetar os nomes (ex.: dev-Products).
const tables = {
  products: process.env.PRODUCTS_TABLE || 'products',
  orders: process.env.ORDERS_TABLE || 'orders',
  payments: process.env.PAYMENTS_TABLE || 'payments',
  stockreservations: process.env.STOCK_RESERVATIONS_TABLE || 'stock-reservations',
  inventory: process.env.INVENTORY_TABLE || 'inventory',
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

/**
 * `consistentRead`: lê a gravação mais recente. Necessário logo depois de uma
 * escrita (ex.: gravação condicional que falhou, passo seguinte da saga): a
 * leitura padrão, eventualmente consistente, pode não enxergar o item ainda.
 */
async function getItem(tableType, key, { consistentRead = false } = {}) {
  const { Item } = await docClient.send(new GetCommand({
    TableName: getTable(tableType),
    Key: key,
    ...(consistentRead && { ConsistentRead: true })
  }));
  return Item;
}

/**
 * `retry: false`: leitura acessória que degrada se falhar (ver noRetryDocClient)
 */
async function queryItems(tableType, queryParams, { retry = true } = {}) {
  const client = retry ? docClient : noRetryDocClient;
  const items = [];
  let ExclusiveStartKey;

  // Percorre todas as páginas da consulta (limite de 1MB por chamada)
  do {
    const result = await client.send(new QueryCommand({
      TableName: getTable(tableType),
      ...queryParams,
      ExclusiveStartKey
    }));
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

/**
 * `retry: false`: para escritas que não são idempotentes (ver noRetryDocClient)
 */
async function updateItem(tableType, key, updateExpression, expressionAttributeValues, options = {}) {
  const client = options.retry === false ? noRetryDocClient : docClient;
  const { Attributes } = await client.send(new UpdateCommand({
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

// `indexName`: varre um GSI (ex.: um índice esparso, bem menor que a tabela)
async function scanItems(tableType, { indexName } = {}) {
  const items = [];
  let ExclusiveStartKey;

  // Percorre todas as páginas do scan (limite de 1MB por chamada)
  do {
    const result = await docClient.send(new ScanCommand({
      TableName: getTable(tableType),
      ...(indexName && { IndexName: indexName }),
      ExclusiveStartKey
    }));
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

/**
 * Uma página do scan: até `limit` itens a partir do cursor `startKey`.
 * `lastKey` é o cursor da próxima página (undefined na última).
 */
async function scanPage(tableType, { limit, startKey } = {}) {
  const result = await scanDocClient.send(new ScanCommand({
    TableName: getTable(tableType),
    ...(limit && { Limit: limit }),
    ...(startKey && { ExclusiveStartKey: startKey })
  }));
  return { items: result.Items || [], lastKey: result.LastEvaluatedKey };
}

async function deleteItem(tableType, key, options = {}) {
  await docClient.send(new DeleteCommand({
    TableName: getTable(tableType),
    Key: key,
    ...(options.conditionExpression && { ConditionExpression: options.conditionExpression })
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

  async getItem(tableType, key, options) {
    return getItem(tableType, key, options);
  }

  async queryItems(tableType, queryParams, options) {
    return queryItems(tableType, queryParams, options);
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

  async scanItems(tableType, options) {
    return scanItems(tableType, options);
  }

  async scanPage(tableType, options) {
    return scanPage(tableType, options);
  }

  async deleteItem(tableType, key, options) {
    return deleteItem(tableType, key, options);
  }
}

export { docClient, tables };
export default Database;
export { putItem, putItemIfNotExists, getItem, queryItems, updateItem, transactWrite, scanItems, scanPage, deleteItem };
export { getTable };
