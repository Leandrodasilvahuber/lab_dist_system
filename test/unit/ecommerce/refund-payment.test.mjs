import { refundPaymentHandler as handler } from '../../../src/functions/ecommerce/refundpaymenthandler.mjs';
import { getItem, updateItem, queryItems } from '../../../src/shared/database.mjs';
import { handler as refundPaymentHandler } from '../../../src/functions/ecommerce/refund-payment.mjs'
import { createSuccessResponse, createErrorResponse } from '../../../src/shared/response.mjs'
import { describe, it, beforeEach, mock } from 'node:test'
import assert from "node:assert/strict"

describe('Refund Payment', () => {
  let mockEvent, getItemSpy = mock.fn(), updateItemSpy, queryItemsSpy

  beforeEach(() => {
    getItemSpy = mock.fn()
    getItemSpy.mockResolvedValue(null)
    updateItemSpy = mock.fn()
    updateItemSpy.mockResolvedValue(undefined)
    queryItemsSpy = mock.fn()
    queryItemsSpy.mockResolvedValue([])
    mockEvent = {
      headers: {
        correlationId: 'test-correlation-123'
      },
      pathParameters: {
        orderId: 'order-123'
      }
    }
  })

  describe('successful refund', () => {
    it('should refund approved payment', async () => {
      getItemSpy.mockResolvedValueOnce({
        id: 'order-123'
      })
      queryItemsSpy.mockResolvedValueOnce([
        { id: 'payment-123', orderId: 'order-123', status: 'APPROVED' }
      ])

      const result = await refundPaymentHandler(mockEvent)

      assert.strictEqual(result.statusCode, 200)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.paymentId, 'payment-123')
      assert.strictEqual(body.status, 'REFUNDED')
    })

    it('should update payment status to REFUNDED', async () => {
      getItemSpy.mockResolvedValueOnce({
        id: 'order-123'
      })
      queryItemsSpy.mockResolvedValueOnce([
        { id: 'payment-123', orderId: 'order-123', status: 'APPROVED' }
      ])

      await refundPaymentHandler(mockEvent)

      assert.strictEqual(updateItemSpy.mock.callCount, 1)
      const updateArgs = updateItemSpy.mock.calls[0]
      assert.strictEqual(updateArgs[0], 'payments')
      assert.deepStrictEqual(updateArgs[1], { id: 'payment-123' })
      assert.ok(updateArgs[2].includes(':status'))
      const exprValues = updateArgs[3]
      assert.strictEqual(exprValues[':status'], 'REFUNDED')
    })
  })

  describe('already refunded payment', () => {
    it('should return success response for already refunded payment', async () => {
      getItemSpy.mockResolvedValueOnce({
        id: 'order-123'
      })
      queryItemsSpy.mockResolvedValueOnce([
        { id: 'payment-123', orderId: 'order-123', status: 'REFUNDED' }
      ])

      const result = await refundPaymentHandler(mockEvent)

      assert.strictEqual(result.statusCode, 200)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.status, 'REFUNDED')
    })
  })

  describe('validation errors', () => {
    it('should return 400 error for missing orderId', async () => {
      mockEvent.pathParameters = {}

      const result = await refundPaymentHandler(mockEvent)

      assert.strictEqual(result.statusCode, 400)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Missing orderId')
    })

    it('should return 404 error for non-existent order', async () => {
      getItemSpy.mockResolvedValueOnce(null)

      const result = await refundPaymentHandler(mockEvent)

      assert.strictEqual(result.statusCode, 404)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Order not found')
    })

    it('should return 404 error for payment not found', async () => {
      getItemSpy.mockResolvedValueOnce({
        id: 'order-123'
      })
      queryItemsSpy.mockResolvedValueOnce([])

      const result = await refundPaymentHandler(mockEvent)

      assert.strictEqual(result.statusCode, 404)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Payment not found for order')
    })
  })

  describe('database errors', () => {
    it('should return 500 error on DynamoDB failure', async () => {
      getItemSpy.mockRejectedValueOnce(new Error('DynamoDB connection failed'))

      const result = await refundPaymentHandler(mockEvent)

      assert.strictEqual(result.statusCode, 500)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Failed to refund payment')
    })
  })
})