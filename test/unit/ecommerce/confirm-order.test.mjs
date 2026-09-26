import { handler as confirmOrderHandler } from '../../../src/functions/ecommerce/confirm-order.mjs';
import { getItem, updateItem, queryItems } from '../../../src/shared/database.mjs';
import { handler as confirmOrderHandler } from '../../../src/functions/ecommerce/confirm-order.mjs'
import { createSuccessResponse, createErrorResponse } from '../../../src/shared/response.mjs'
import { describe, it, beforeEach, mock } from 'node:test'
import assert from "node:assert/strict"

describe('Confirm Order', () => {
  let mockEvent, getItemSpy = mock.fn(), updateItemSpy

  beforeEach(() => {
    getItemSpy = mock.fn()
    getItemSpy.mockResolvedValue(null)
    updateItemSpy = mock.fn()
    updateItemSpy.mockResolvedValue(undefined)
    mockEvent = {
      headers: {
        correlationId: 'test-correlation-123'
      },
      pathParameters: {
        orderId: 'order-123'
      }
    }
  })

  describe('successful order confirmation', () => {
    it('should confirm order with STOCK_RESERVED status', async () => {
      const order = {
        id: 'order-123',
        status: 'STOCK_RESERVED',
        productId: 'tux-shirt',
        quantity: 1
      }

      getItemSpy.mockResolvedValueOnce(order)

      const result = await confirmOrderHandler(mockEvent)

      assert.strictEqual(result.statusCode, 200)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.status, 'COMPLETED')
      assert.ok(body.confirmedAt)
    })

    it('should update order status to COMPLETED', async () => {
      const order = {
        id: 'order-123',
        status: 'STOCK_RESERVED'
      }

      getItemSpy.mockResolvedValueOnce(order)

      await confirmOrderHandler(mockEvent)

      assert.strictEqual(updateItemSpy.mock.callCount, 1)
      const updateArgs = updateItemSpy.mock.calls[0]
      assert.strictEqual(updateArgs[0], 'orders')
      assert.deepStrictEqual(updateArgs[1], { id: 'order-123' })
      assert.ok(updateArgs[2].includes(':status'))
      const exprValues = updateArgs[3]
      assert.strictEqual(exprValues[':status'], 'COMPLETED')
    })
  })

  describe('validation errors', () => {
    it('should return 400 error for missing orderId', async () => {
      mockEvent.pathParameters = {}

      const result = await confirmOrderHandler(mockEvent)

      assert.strictEqual(result.statusCode, 400)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Missing orderId')
    })

    it('should return 404 error for non-existent order', async () => {
      getItemSpy.mockResolvedValueOnce(null)

      const result = await confirmOrderHandler(mockEvent)

      assert.strictEqual(result.statusCode, 404)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Order not found')
    })

    it('should return 400 error for order not in STOCK_RESERVED status', async () => {
      const order = {
        id: 'order-123',
        status: 'STARTED'
      }

      getItemSpy.mockResolvedValueOnce(order)

      const result = await confirmOrderHandler(mockEvent)

      assert.strictEqual(result.statusCode, 400)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Order must have stock reserved before confirmation')
    })
  })

  describe('database errors', () => {
    it('should return 500 error on DynamoDB failure', async () => {
      getItemSpy.mockRejectedValueOnce(new Error('DynamoDB connection failed'))

      const result = await confirmOrderHandler(mockEvent)

      assert.strictEqual(result.statusCode, 500)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Failed to confirm order')
    })
  })
})