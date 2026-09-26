import { Logger } from '../../../src/shared/logger.mjs'
import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

describe('Logger', () => {
  let logger
  let logCallCount = 0
  const capturedLogs = []

  beforeEach(() => {
    logger = new Logger()
    logCallCount = 0
    capturedLogs.length = 0

    // Mock console.log to capture calls
    console.log = (...args) => {
      logCallCount++
      capturedLogs.push(args)
    }

    // Restore console.log after each test
    mock.method(console, 'log').mockRestore = () => {
      console.log = (...args) => {
        logCallCount++
        capturedLogs.push(args)
      }
    }
  })

  describe('event', () => {
    it('should log info event with correlation ID', () => {
      const correlationId = 'test-correlation-123'
      const event = {
        detail: { action: 'CREATE_ORDER' },
        timestamp: new Date().toISOString()
      }

      logger.event(correlationId, 'info', event)

      assert.ok(logCallCount >= 1)
      const call = capturedLogs[0]
      assert.ok(call.length >= 1)
      const logString = call[0]
      assert.ok(logString.includes('test-correlation-123'))
      assert.ok(logString.includes('CREATE_ORDER'))
    })

    it('should log error event with correlation ID', () => {
      const correlationId = 'test-correlation-456'
      const event = {
        detail: { action: 'PAYMENT_FAILED', error: 'Payment declined' },
        timestamp: new Date().toISOString()
      }

      logger.event(correlationId, 'error', event)

      assert.ok(logCallCount >= 1)
      const call = capturedLogs[0]
      assert.ok(call.length >= 1)
      const logString = call[0]
      assert.ok(logString.includes('test-correlation-456'))
      assert.ok(logString.includes('PAYMENT_FAILED'))
      assert.ok(logString.includes('Payment declined'))
    })

    it('should log warning event with correlation ID', () => {
      const correlationId = 'test-correlation-789'
      const event = {
        detail: { action: 'STOCK_LOW', threshold: 10 },
        timestamp: new Date().toISOString()
      }

      logger.event(correlationId, 'warning', event)

      assert.ok(logCallCount >= 1)
      const call = capturedLogs[0]
      assert.ok(call.length >= 1)
      const logString = call[0]
      assert.ok(logString.includes('test-correlation-789'))
      assert.ok(logString.includes('STOCK_LOW'))
    })
  })

  describe('status', () => {
    it('should log success status', () => {
      const correlationId = 'test-correlation-101'
      const action = 'CREATE_ORDER'
      const status = 'SUCCESS'

      logger.status(correlationId, action, status)

      assert.ok(logCallCount >= 1)
      const call = capturedLogs[0]
      assert.ok(call.length >= 1)
      const logString = call[0]
      assert.ok(logString.includes('test-correlation-101'))
      assert.ok(logString.includes(action))
      assert.ok(logString.includes(status))
    })

    it('should log failure status', () => {
      const correlationId = 'test-correlation-202'
      const action = 'PAYMENT'
      const status = 'FAILED'

      logger.status(correlationId, action, status)

      assert.ok(logCallCount >= 1)
      const call = capturedLogs[0]
      assert.ok(call.length >= 1)
      const logString = call[0]
      assert.ok(logString.includes('test-correlation-202'))
      assert.ok(logString.includes(action))
      assert.ok(logString.includes(status))
    })
  })

  describe('error', () => {
    it('should log error with message', () => {
      const correlationId = 'test-correlation-303'
      const action = 'ORDER_CANCEL'
      const error = new Error('Cannot cancel completed order')

      logger.error(correlationId, action, error)

      assert.ok(logCallCount >= 1)
      const call = capturedLogs[0]
      assert.ok(call.length >= 1)
      const logString = call[0]
      assert.ok(logString.includes('test-correlation-303'))
      assert.ok(logString.includes(action))
      assert.ok(logString.includes('Cannot cancel completed order'))
    })

    it('should log error without message', () => {
      const correlationId = 'test-correlation-404'
      const action = 'STOCK_RESERVE'
      const error = {}

      logger.error(correlationId, action, error)

      assert.ok(logCallCount >= 1)
      const call = capturedLogs[0]
      assert.ok(call.length >= 1)
      const logString = call[0]
      assert.ok(logString.includes('test-correlation-404'))
      assert.ok(logString.includes(action))
      assert.ok(logString.includes('{}'))
    })
  })

  describe('trace', () => {
    it('should trace function execution time', () => {
      const correlationId = 'test-correlation-505'
      const action = 'GET_PRODUCTS'

      // Mock performance timing
      const originalNow = performance.now
      performance.now = () => 1000

      logger.trace(correlationId, action, () => {
        // Simulate some work
        performance.now = () => 1100
      })

      // Restore original
      performance.now = originalNow

      assert.ok(logCallCount >= 1)
      const call = capturedLogs[0]
      assert.ok(call.length >= 1)
      const logString = call[0]
      assert.ok(logString.includes('test-correlation-505'))
      assert.ok(logString.includes(action))
      assert.ok(logString.includes('100ms'))
    })

    it('should handle exception during trace', () => {
      const correlationId = 'test-correlation-606'
      const action = 'CREATE_ORDER'

      assert.throws(() => {
        logger.trace(correlationId, action, () => {
          throw new Error('Test error')
        })
      }, /Test error/)

      assert.ok(logCallCount >= 1)
      const call = capturedLogs[0]
      assert.ok(call.length >= 1)
      const logString = call[0]
      assert.ok(logString.includes('test-correlation-606'))
      assert.ok(logString.includes(action))
      assert.ok(logString.includes('Test error'))
    })
  })
})
