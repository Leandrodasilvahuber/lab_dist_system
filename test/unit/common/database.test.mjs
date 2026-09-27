import {
  putItem,
  getItem,
  queryItems,
  updateItem,
  scanItems,
  docClient,
  tables,
  Database
} from '../../../src/common/database.mjs';

// Mock AWS DynamoDB SDK
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const { DynamoDBClient, PutCommand, GetCommand, QueryCommand, UpdateCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

describe('Database Module', () => {
  const mockSend = jest.fn();
  const mockDocClient = {
    send: mockSend
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockClear();
  });

  describe('getTable function', () => {
    test('should return table name from mapping', () => {
      const tableName = getTable('products');
      assert.strictEqual(tableName, 'Products');
    });

    test('should return table type as table name if not mapped', () => {
      const tableName = getTable('unknown_table');
      assert.strictEqual(tableName, 'unknown_table');
    });
  });

  describe('putItem', () => {
    test('should put item in DynamoDB table', async () => {
      const mockResponse = { Attributes: { id: '1' } };
      mockSend.mockResolvedValue(mockResponse);

      const item = { id: '1', name: 'Product' };
      const result = await putItem('products', item);

      expect(mockSend).toHaveBeenCalledWith(expect.any(PutCommand));
      const command = mockSend.mock.calls[0][0];
      assert.strictEqual(command.input.TableName, 'Products');
      assert.deepStrictEqual(command.input.Item, item);
      assert.deepStrictEqual(result, { id: '1' });
    });
  });

  describe('getItem', () => {
    test('should get item from DynamoDB table', async () => {
      const mockResponse = { Item: { id: '1', name: 'Product' } };
      mockSend.mockResolvedValue(mockResponse);

      const key = { id: '1' };
      const result = await getItem('products', key);

      expect(mockSend).toHaveBeenCalledWith(expect.any(GetCommand));
      const command = mockSend.mock.calls[0][0];
      assert.strictEqual(command.input.TableName, 'Products');
      assert.deepStrictEqual(command.input.Key, key);
      assert.deepStrictEqual(result, { id: '1', name: 'Product' });
    });
  });

  describe('queryItems', () => {
    test('should query items from DynamoDB table', async () => {
      const mockResponse = { Items: [{ id: '1' }, { id: '2' }] };
      mockSend.mockResolvedValue(mockResponse);

      const queryParams = { KeyConditionExpression: 'id = :id' };
      const result = await queryItems('orders', queryParams);

      expect(mockSend).toHaveBeenCalledWith(expect.any(QueryCommand));
      const command = mockSend.mock.calls[0][0];
      assert.strictEqual(command.input.TableName, 'Orders');
      assert.strictEqual(command.input.KeyConditionExpression, 'id = :id');
      assert.deepStrictEqual(result, [{ id: '1' }, { id: '2' }]);
    });
  });

  describe('updateItem', () => {
    test('should update item in DynamoDB table', async () => {
      const mockResponse = { Attributes: { id: '1', updated: true } };
      mockSend.mockResolvedValue(mockResponse);

      const key = { id: '1' };
      const updateExpression = 'set #attr = :val';
      const expressionAttributeValues = { ':val': 'updated' };
      const result = await updateItem('orders', key, updateExpression, expressionAttributeValues);

      expect(mockSend).toHaveBeenCalledWith(expect.any(UpdateCommand));
      const command = mockSend.mock.calls[0][0];
      assert.strictEqual(command.input.TableName, 'Orders');
      assert.deepStrictEqual(command.input.Key, key);
      assert.strictEqual(command.input.UpdateExpression, 'set #attr = :val');
      assert.deepStrictEqual(command.input.ExpressionAttributeValues, expressionAttributeValues);
      assert.strictEqual(command.input.ReturnValues, 'UPDATED_NEW');
      assert.deepStrictEqual(result, { id: '1', updated: true });
    });
  });

  describe('scanItems', () => {
    test('should scan items from DynamoDB table', async () => {
      const mockResponse = { Items: [{ id: '1' }, { id: '2' }] };
      mockSend.mockResolvedValue(mockResponse);

      const result = await scanItems('products');

      expect(mockSend).toHaveBeenCalledWith(expect.any(ScanCommand));
      const command = mockSend.mock.calls[0][0];
      assert.strictEqual(command.input.TableName, 'Products');
      assert.deepStrictEqual(result, [{ id: '1' }, { id: '2' }]);
    });
  });

  describe('Database Class', () => {
    let database;

    beforeEach(() => {
      database = new Database();
    });

    test('should create Database instance', () => {
      expect(database).toBeInstanceOf(Database);
      assert(database.docClient !== undefined);
    });

    test('should put item using Database class', async () => {
      const mockResponse = { Attributes: { id: '1' } };
      mockSend.mockResolvedValue(mockResponse);

      const item = { id: '1', name: 'Product' };
      const result = await database.putItem('products', item);

      assert.strictEqual(mockSend.mock.calls.length, 1);
      assert.deepStrictEqual(result, { id: '1' });
    });

    test('should get item using Database class', async () => {
      const mockResponse = { Item: { id: '1', name: 'Product' } };
      mockSend.mockResolvedValue(mockResponse);

      const key = { id: '1' };
      const result = await database.getItem('products', key);

      assert.strictEqual(mockSend.mock.calls.length, 1);
      assert.deepStrictEqual(result, { id: '1', name: 'Product' });
    });

    test('should query items using Database class', async () => {
      const mockResponse = { Items: [{ id: '1' }] };
      mockSend.mockResolvedValue(mockResponse);

      const queryParams = { KeyConditionExpression: 'id = :id' };
      const result = await database.queryItems('orders', queryParams);

      assert.strictEqual(mockSend.mock.calls.length, 1);
      assert.deepStrictEqual(result, [{ id: '1' }]);
    });

    test('should update item using Database class', async () => {
      const mockResponse = { Attributes: { id: '1', updated: true } };
      mockSend.mockResolvedValue(mockResponse);

      const key = { id: '1' };
      const updateExpression = 'set #attr = :val';
      const expressionAttributeValues = { ':val': 'updated' };
      const result = await database.updateItem('orders', key, updateExpression, expressionAttributeValues);

      assert.strictEqual(mockSend.mock.calls.length, 1);
      assert.deepStrictEqual(result, { id: '1', updated: true });
    });

    test('should scan items using Database class', async () => {
      const mockResponse = { Items: [{ id: '1' }] };
      mockSend.mockResolvedValue(mockResponse);

      const result = await database.scanItems('products');

      assert.strictEqual(mockSend.mock.calls.length, 1);
      assert.deepStrictEqual(result, [{ id: '1' }]);
    });
  });

  describe('Tables Configuration', () => {
    test('should have correct table mappings', () => {
      expect(tables).toEqual({
        products: 'Products',
        orders: 'Orders',
        payments: 'Payments',
        sagas: 'Sagas'
      });
    });
  });
});