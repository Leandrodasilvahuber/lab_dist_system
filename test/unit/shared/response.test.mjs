import {
  successResponse,
  errorResponse,
  createOkResponse
} from '../../../src/shared/response.mjs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('Response Utils', () => {
  describe('successResponse', () => {
    it('should create success response with data', () => {
      const data = { id: 'test', name: 'Test Product' }
      const response = successResponse(data, 200)

      assert.strictEqual(response.statusCode, 200)
      assert.strictEqual(response.headers['Content-Type'], 'application/json')
      assert.strictEqual(response.headers['Access-Control-Allow-Origin'], '*')
      assert.strictEqual(JSON.parse(response.body).id, 'test')
      assert.strictEqual(JSON.parse(response.body).name, 'Test Product')
    })

    it('should create success response without data', () => {
      const response = successResponse({}, 200)

      assert.strictEqual(response.statusCode, 200)
      assert.strictEqual(response.headers['Content-Type'], 'application/json')
      assert.strictEqual(response.headers['Access-Control-Allow-Origin'], '*')
      assert.deepStrictEqual(JSON.parse(response.body), {})
    })
  })

  describe('errorResponse', () => {
    it('should create error response with custom status', () => {
      const error = new Error('Custom error message')
      const response = errorResponse('Custom error message', 400, error)

      assert.strictEqual(response.statusCode, 400)
      assert.strictEqual(response.headers['Content-Type'], 'application/json')
      assert.strictEqual(response.headers['Access-Control-Allow-Origin'], '*')
      const body = JSON.parse(response.body)
      assert.strictEqual(body.error, 'Custom error message')
      assert.strictEqual(body.details, 'Custom error message')
    })

    it('should create error response with default status', () => {
      const error = new Error('Internal server error')
      const response = errorResponse('Internal server error', 500, error)

      assert.strictEqual(response.statusCode, 500)
      assert.strictEqual(response.headers['Content-Type'], 'application/json')
      assert.strictEqual(response.headers['Access-Control-Allow-Origin'], '*')
      const body = JSON.parse(response.body)
      assert.strictEqual(body.error, 'Internal server error')
      assert.strictEqual(body.details, 'Internal server error')
    })

    it('should handle error without message', () => {
      const response = errorResponse('Resource not found', 404, null)

      assert.ok(response.body.includes('"error":"Resource not found"'))
    })
  })

  describe('createOkResponse', () => {
    it('should create 200 OK response', () => {
      const response = createOkResponse({})

      assert.strictEqual(response.statusCode, 200)
      assert.strictEqual(response.headers['Content-Type'], 'application/json')
      assert.strictEqual(response.headers['Access-Control-Allow-Origin'], '*')
      assert.deepStrictEqual(JSON.parse(response.body), {})
    })
  })
})