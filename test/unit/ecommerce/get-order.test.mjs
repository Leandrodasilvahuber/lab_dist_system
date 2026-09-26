import { getOrderHandler as handler } from '../../../src/functions/ecommerce/getorderhandler.mjs';
import { getItem, updateItem, queryItems } from '../../../src/shared/database.mjs';
import { handler as getOrderHandler } from '../../../src/functions/ecommerce/get-order.mjs'
import { createSuccessResponse, createErrorResponse } from '../../../src/shared/response.mjs'
import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

describe('Get Order', () => {
  let mockEvent, scanItemsSpy = mock.fn(), getItemSpy

  beforeEach(() => {
    scanItemsSpy = mock.fn()
    scanItemsSpy.mockResolvedValue([])
    getItemSpy = mock.fn()
    getItemSpy.mockResolvedValue(null)
    mockEvent = {
      headers: {
        correlationId: 'test-correlation-123'
      }
    }
  })

  describe('get all orders', () => {
    it('should return all orders', async () => {
      const orders = [
        { id: 'order-1', productId: 'product-1', quantity: 2, total: 20, status: 'STARTED', createdAt: new Date().toISOString() },
        { id: 'order-2', productId: 'product-2', quantity: 1, total: 15, status: 'COMPLETED', createdAt: new Date().toISOString() }
      ]

      scanItemsSpy.mockResolvedValueOnce(orders)

      const result = await getOrderHandler(mockEvent)

      assert.strictEqual(result.statusCode, 200)
      const body = JSON.parse(result.body)
      assert.deepStrictEqual(body, orders)
      assert.strictEqual(scanItemsSpy.mock.callCount, 1)
    })

    it('should return empty array when no orders exist', async () => {
      scanItemsSpy.mockResolvedValueOnce([])

      const result = await getOrderHandler(mockEvent)

      assert.strictEqual(result.statusCode, 200)
      const body = JSON.parse(result.body)
      assert.deepStrictEqual(body, [])
    })
  })

  describe('get order by id', () => {
    it('should return specific order', async () => {
      const order = {
        id: 'order-1',
        productId: 'product-1',
        quantity: 2,
        total: 20,
        status: 'COMPLETED',
        createdAt: new Date().toISOString()
      }

      getItemSpy.mockResolvedValueOnce(order)

      const result = await getOrderHandler(mockEvent, { id: 'order-1' })

      assert.strictEqual(result.statusCode, 200)
      const body = JSON.parse(result.body)
      assert.deepStrictEqual(body, order)
      assert.strictEqual(getItemSpy.mock.callCount, 1)
    })

    it('should return 404 for non-existent order', async () => {
      getItemSpy.mockResolvedValueOnce(null)

      const result = await getOrderHandler(mockEvent, { id: 'non-existent' })

      assert.strictEqual(result.statusCode, 404)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Order not found')
    })
  })

  describe('database errors', () => {
    it('should return 500 error on DynamoDB failure', async () => {
      scanItemsSpy.mockRejectedValueOnce(new Error('DynamoDB connection failed'))

      const result = await getOrderHandler(mockEvent)

      assert.strictEqual(result.statusCode, 500)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Failed to get orders')
    })
  })
})