import { getProductsHandler as handler } from '../../../src/functions/ecommerce/getproductshandler.mjs';
import { getItem, updateItem, queryItems } from '../../../src/shared/database.mjs';
import { handler as getProductsHandler } from '../../../src/functions/ecommerce/get-products.mjs'
import { createSuccessResponse, createErrorResponse } from '../../../src/shared/response.mjs'
import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

describe('Get Products', () => {
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

  describe('get all products', () => {
    it('should return all products', async () => {
      const products = [
        { id: 'product-1', name: 'Product 1', price: 10, stock: 100 },
        { id: 'product-2', name: 'Product 2', price: 20, stock: 200 }
      ]

      scanItemsSpy.mockResolvedValueOnce(products)

      const result = await getProductsHandler(mockEvent)

      assert.strictEqual(result.statusCode, 200)
      const body = JSON.parse(result.body)
      assert.deepStrictEqual(body, products)
      assert.strictEqual(scanItemsSpy.mock.callCount, 1)
    })

    it('should return empty array when no products exist', async () => {
      scanItemsSpy.mockResolvedValueOnce([])

      const result = await getProductsHandler(mockEvent)

      assert.strictEqual(result.statusCode, 200)
      const body = JSON.parse(result.body)
      assert.deepStrictEqual(body, [])
    })
  })

  describe('get product by id', () => {
    it('should return specific product', async () => {
      const product = {
        id: 'product-1',
        name: 'Product 1',
        price: 10,
        stock: 100
      }

      getItemSpy.mockResolvedValueOnce(product)

      const result = await getProductsHandler(mockEvent, { id: 'product-1' })

      assert.strictEqual(result.statusCode, 200)
      const body = JSON.parse(result.body)
      assert.deepStrictEqual(body, product)
      assert.strictEqual(getItemSpy.mock.callCount, 1)
    })

    it('should return 404 for non-existent product', async () => {
      getItemSpy.mockResolvedValueOnce(null)

      const result = await getProductsHandler(mockEvent, { id: 'non-existent' })

      assert.strictEqual(result.statusCode, 404)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Product not found')
    })
  })

  describe('database errors', () => {
    it('should return 500 error on DynamoDB failure', async () => {
      scanItemsSpy.mockRejectedValueOnce(new Error('DynamoDB connection failed'))

      const result = await getProductsHandler(mockEvent)

      assert.strictEqual(result.statusCode, 500)
      const body = JSON.parse(result.body)
      assert.strictEqual(body.error, 'Failed to get products')
    })
  })
})
