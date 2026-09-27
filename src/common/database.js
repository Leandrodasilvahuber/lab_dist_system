import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
    sessionToken: process.env.AWS_SESSION_TOKEN || 'test'
  }
}));

export const DynamoDBClientClass = {
  get docClient() {
    return docClient;
  },

  async getItem(tableName, id, attributeName = 'id') {
    const result = await docClient.get({
      TableName: tableName,
      Key: { [attributeName]: id }
    });
    return result.Item;
  },

  async putItem(tableName, item) {
    await docClient.put({ TableName: tableName, Item: item });
    return item;
  },

  async updateItem(tableName, id, updates, attributeName = 'id') {
    const updateExpressions = [];
    const expressionAttributeValues = {};

    Object.entries(updates).forEach(([key, value]) => {
      updateExpressions.push(`${key} = :${key}`);
      expressionAttributeValues[`:${key}`] = { value };
    });

    await docClient.update({
      TableName: tableName,
      Key: { [attributeName]: id },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeValues: expressionAttributeValues
    });
  },

  async deleteItem(tableName, id, attributeName = 'id') {
    await docClient.delete({
      TableName: tableName,
      Key: { [attributeName]: id }
    });
  },

  async queryItems(tableName, params) {
    const result = await docClient.query({
      TableName: tableName,
      ...params
    });
    return result.Items;
  }
};

export default DynamoDBClientClass;
