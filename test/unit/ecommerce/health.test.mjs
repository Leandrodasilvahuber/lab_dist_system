import { handler as healthHandler } from '../../../src/functions/ecommerce/health.mjs'
import { createSuccessResponse, createErrorResponse } from '../../../src/shared/response.mjs'
import { Logger } from '../../../src/shared/logger.mjs'
import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

describe('Health Handler', () => {
  let mockEvent, logger

  beforeEach(() => {
    mockEvent = {
      headers: {
        'Content-Type': 'application/json'
      }
    }

    logger = new Logger('health')
  })

  describe('successful health check', () => {
    it('should return healthy status', async () => {
      const result = await healthHandler(mockEvent)

      assert.strictEqual(result.statusCode, 200)
    })

    it('should include check information', async () => {
      const result = await healthHandler(mockEvent)

      assert.strictEqual(result.statusCode, 200)
      const data = JSON.parse(result.body)
      assert.ok(data.status)
      assert.ok(data.service)
      assert.ok(data.timestamp)
    })
  })

  describe('logging', () => {
    it('should log health check', async () => {
      await healthHandler(mockEvent)
    })
  })
})