import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(client);

const tables = {
  products: 'Products',
  orders: 'Orders',
  payments: 'Payments',
  sagas: 'Sagas'
};

async function getTable(tableType) {
  return tables[tableType] || tableType;
}

export async function putItem(tableType, item) {
  const table = await getTable(tableType);
  const command = new PutCommand({
    TableName: table,
    Item: item
  });

  const { Attributes } = await docClient.send(command);
  return Attributes;
}

export async function getItem(tableType, key) {
  const table = await getTable(tableType);
  const command = new GetCommand({
    TableName: table,
    Key: key
  });

  const { Item } = await docClient.send(command);
  return Item;
}

export async function queryItems(tableType, queryParams) {
  const table = await getTable(tableType);
  const command = new QueryCommand({
    TableName: table,
    ...queryParams
  });

  const { Items } = await docClient.send(command);
  return Items;
}

export async function updateItem(tableType, key, updateExpression, expressionAttributeValues) {
  const table = await getTable(tableType);
  const command = new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'UPDATED_NEW'
  });

  const { Attributes } = await docClient.send(command);
  return Attributes;
}

export async function scanItems(tableType) {
  const table = await getTable(tableType);
  const command = new ScanCommand({
    TableName: table
  });

  const { Items } = await docClient.send(command);
  return Items;
}

export { docClient, tables };

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

  async updateItem(tableType, key, updateExpression, expressionAttributeValues) {
    return updateItem(tableType, key, updateExpression, expressionAttributeValues);
  }

  async scanItems(tableType) {
    return scanItems(tableType);
  }
}