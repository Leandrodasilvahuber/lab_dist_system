import { releaseStockHandler as handler } from '../../../src/functions/ecommerce/releasestockhandler.mjs';
import { getItem, updateItem, queryItems } from '../../../src/shared/database.mjs';
import { handler as releaseStockHandler } from '../../../src/functions/ecommerce/release-stock.mjs'
import { createSuccessResponse, createErrorResponse } from '../../../src/shared/response.mjs'
import { describe, it, beforeEach, mock } from 'node:test'
import assert from "node:assert/strict"

describe('Release Stock', () => {
  let mockEvent, getItemSpy = mock.fn(), updateItemSpy

  beforeEach(() => {
    getItemSpy = mock.fn()
    getItemSpy.mockResolvedValueOnce({ id: 'tux-shirt' })
    updateItemSpy = mock.fn()
    updateItemSpy.mockResolvedValue(undefined)
    mockEvent = {
      headers: {
        correlationId: 'test-correlation-123'
      },
      body: JSON.stringify({
        orderId: 'order-123',
        productId: 'tux-shirt',
        quantity: 1
      })
    }
  })

  describe('successful stock release', () => {
    it('should release stock from product', async () => {
      const result = await releaseStockHandler(mockEvent)

      assert.strictEqual(result.statusCode, 200)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.productId, 'tux-shirt')
      assert.strictEqual(body.quantity, 1)
    })

    it('should increase available stock', async () => {
      await releaseStockHandler(mockEvent)

      assert.strictEqual(updateItemSpy.mock.callCount, 2)
      const productUpdateArgs = updateItemSpy.mock.calls[0]
      assert.strictEqual(productUpdateArgs[0], 'products')
      assert.deepStrictEqual(productUpdateArgs[1], { id: 'tux-shirt' })
      assert.ok(productUpdateArgs[2].includes(':newStock'))
      assert.ok(productUpdateArgs[2].includes(':newReserved'))
    })

    it('should decrease reserved stock', async () => {
      await releaseStockHandler(mockEvent)

      assert.strictEqual(updateItemSpy.mock.callCount, 2)
      const productUpdateArgs = updateItemSpy.mock.calls[0]
      const exprValues = productUpdateArgs[3]
      assert.ok(exprValues[':newReserved'])
    })

    it('should update order status to CANCELLED', async () => {
      await releaseStockHandler(mockEvent)

      assert.strictEqual(updateItemSpy.mock.callCount, 2)
      const orderUpdateArgs = updateItemSpy.calls[1]
      assert.strictEqual(orderUpdateArgs[0], 'orders')
      assert.deepStrictEqual(orderUpdateArgs[1], { id: 'order-123' })
      assert.ok(orderUpdateArgs[2].includes(':status'))
      const exprValues = orderUpdateArgs[3]
      assert.strictEqual(exprValues[':status'], 'CANCELLED')
    })
  })

  describe('validation errors', () => {
    it('should return 400 error for missing orderId', async () => {
      mockEvent.body = JSON.stringify({
        productId: 'tux-shirt',
        quantity: 1
        // missing orderId
      })

      const result = await releaseStockHandler(mockEvent)

      assert.strictEqual(result.statusCode, 400)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Missing required fields: orderId, productId, quantity')
    })

    it('should return 400 error for missing productId', async () => {
      mockEvent.body = JSON.stringify({
        orderId: 'order-123',
        quantity: 1
        // missing productId
      })

      const result = await releaseStockHandler(mockEvent)

      assert.strictEqual(result.statusCode, 400)
    })

    it('should return 400 error for missing quantity', async () => {
      mockEvent.body = JSON.stringify({
        orderId: 'order-123',
        productId: 'tux-shirt'
        // missing quantity
      })

      const result = await releaseStockHandler(mockEvent)

      assert.strictEqual(result.statusCode, 400)
    })

    it('should return 404 error for non-existent order', async () => {
      getItemSpy.mockResolvedValueOnce(null)

      const result = await releaseStockHandler(mockEvent)

      assert.strictEqual(result.statusCode, 404)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Order not found')
    })

    it('should return 404 error for non-existent product', async () => {
      getItemSpy.mockResolvedValueOnce({ id: 'tux-shirt' })
      getItemSpy.mockResolvedValueOnce(null)

      const result = await releaseStockHandler(mockEvent)

      assert.strictEqual(result.statusCode, 404)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Product not found')
    })
  })

  describe('database errors', () => {
    it('should return 500 error on DynamoDB failure', async () => {
      getItemSpy.mockRejectedValueOnce(new Error('DynamoDB connection failed'))

      const result = await releaseStockHandler(mockEvent)

      assert.strictEqual(result.statusCode, 500)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Failed to release stock')
    })
  })
})