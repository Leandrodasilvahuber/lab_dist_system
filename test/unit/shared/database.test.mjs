import { Database } from '../../../src/shared/database.mjs'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

describe('Database', () => {
  let database
  let sendOriginal

  beforeEach(() => {
    database = new Database()
    sendOriginal = database.docClient.send.bind(database.docClient)
  })

  afterEach(() => {
    // Restore original method
    database.docClient.send = sendOriginal
  })

  describe('putItem', () => {
    it('should successfully put item in DynamoDB', async () => {
      const mockResponse = { Attributes: { id: 'test', name: 'Test Item' } }

      // Mock the docClient.send method
      database.docClient.send = async (command) => {
        return mockResponse
      }

      const item = { id: 'test', name: 'Test Item' }
      const result = await database.putItem('TestTable', item)

      assert.strictEqual(result.id, 'test')
      assert.strictEqual(result.name, 'Test Item')
    })

    it('should handle DynamoDB errors', async () => {
      const error = new Error('DynamoDB error')

      // Mock the docClient.send method
      database.docClient.send = async (command) => {
        throw error
      }

      await assert.rejects(database.putItem('TestTable', { id: 'test' }), /DynamoDB error/)
    })
  })

  describe('getItem', () => {
    it('should successfully get item from DynamoDB', async () => {
      const mockResponse = { Item: { id: 'test', name: 'Test Item' } }

      // Mock the docClient.send method
      database.docClient.send = async (command) => {
        return mockResponse
      }

      const result = await database.getItem('TestTable', 'test')

      assert.strictEqual(result.id, 'test')
      assert.strictEqual(result.name, 'Test Item')
    })

    it('should handle item not found', async () => {
      // Mock the docClient.send method to return empty response
      database.docClient.send = async (command) => {
        return { Item: undefined }
      }

      const result = await database.getItem('TestTable', 'nonexistent')

      assert.strictEqual(result, undefined)
    })
  })

  describe('updateItem', () => {
    it('should successfully update item in DynamoDB', async () => {
      const mockResponse = { Attributes: { id: 'test', name: 'Updated Name' } }

      // Mock the docClient.send method
      database.docClient.send = async (command) => {
        return mockResponse
      }

      const updateExpression = 'SET #attr = :val'
      const expressionAttributes = {
        '#attr': 'name',
        ':val': 'Updated Name'
      }

      await database.updateItem('TestTable', 'test', updateExpression, expressionAttributes)
    })
  })

  describe('queryItems', () => {
    it('should successfully query items from DynamoDB', async () => {
      const mockResponse = { Items: [
        { id: 'test1', name: 'Test Item 1' },
        { id: 'test2', name: 'Test Item 2' }
      ] }

      // Mock the docClient.send method
      database.docClient.send = async (command) => {
        return mockResponse
      }

      const result = await database.queryItems('TestTable', 'id = :val', { ':val': 'test' })

      assert.strictEqual(result.length, 2)
      assert.strictEqual(result[0].id, 'test1')
      assert.strictEqual(result[1].id, 'test2')
    })

    it('should handle empty query result', async () => {
      // Mock the docClient.send method to return empty items
      database.docClient.send = async (command) => {
        return { Items: [] }
      }

      const result = await database.queryItems('TestTable', 'id = :val', { ':val': 'test' })

      assert.strictEqual(result.length, 0)
    })
  })

  describe('scanItems', () => {
    it('should successfully scan items from DynamoDB', async () => {
      const mockResponse = { Items: [
        { id: 'test1', name: 'Test Item 1' },
        { id: 'test2', name: 'Test Item 2' }
      ] }

      // Mock the docClient.send method
      database.docClient.send = async (command) => {
        return mockResponse
      }

      const result = await database.scanItems('TestTable')

      assert.strictEqual(result.length, 2)
      assert.strictEqual(result[0].id, 'test1')
      assert.strictEqual(result[1].id, 'test2')
    })

    it('should handle empty scan result', async () => {
      // Mock the docClient.send method to return empty items
      database.docClient.send = async (command) => {
        return { Items: [] }
      }

      const result = await database.scanItems('TestTable')

      assert.strictEqual(result.length, 0)
    })
  })
})
