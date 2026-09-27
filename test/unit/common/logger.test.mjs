import { log, createLogContext, Logger } from '../../../src/common/logger.mjs';
import { spyOn } from '../../../test/test-utils.mjs';

// Mock console functions
const consoleLog = spyOn(console, 'log').mockImplementation(() => {});
const consoleError = spyOn(console, 'error').mockImplementation(() => {});

describe('Logger Module', () => {
  beforeEach(() => {
    consoleLog.mockClear();
    consoleError.mockClear();
  });

  describe('log function', () => {
    test('should log structured log entry', () => {
      const logEntry = {
        event: 'TEST_EVENT',
        orderId: 'test-order-id',
        correlationId: 'test-correlation-id',
        status: 'info',
        message: 'Test message',
        data: { key: 'value' }
      };

      log(logEntry);

      expect(console.log).toHaveBeenCalledWith(JSON.stringify(logEntry));
    });

    test('should log error with error level', () => {
      const error = new Error('Test error');
      const logEntry = {
        event: 'ERROR_EVENT',
        orderId: 'test-order-id',
        correlationId: 'test-correlation-id',
        status: 'error',
        message: 'Error message',
        error
      };

      log(logEntry);

      expect(console.log).toHaveBeenCalledWith(JSON.stringify(logEntry));
      expect(console.error).toHaveBeenCalledWith(JSON.stringify({
        ...logEntry,
        level: 'error'
      }));
    });

    test('should handle null error', () => {
      const logEntry = {
        event: 'INFO_EVENT',
        message: 'Info message',
        error: null
      };

      log(logEntry);

      expect(console.log).toHaveBeenCalledWith(JSON.stringify(logEntry));
      expect(console.error).not.toHaveBeenCalled();
    });
  });

  describe('createLogContext', () => {
    test('should create log context with provided values', () => {
      const context = createLogContext('TEST_EVENT', 'order-123', 'corr-456');

      expect(context).toEqual({
        correlationId: 'corr-456',
        orderId: 'order-123',
        event: 'TEST_EVENT'
      });
    });

    test('should generate correlationId if not provided', () => {
      const context = createLogContext('TEST_EVENT', 'order-123');

      expect(context).toEqual({
        correlationId: expect.any(String),
        orderId: 'order-123',
        event: 'TEST_EVENT'
      });
      expect(context.correlationId).not.toBeUndefined();
    });

    test('should set orderId to null if not provided', () => {
      const context = createLogContext('TEST_EVENT');

      expect(context).toEqual({
        correlationId: expect.any(String),
        orderId: null,
        event: 'TEST_EVENT'
      });
    });
  });

  describe('Logger class', () => {
    let logger;

    beforeEach(() => {
      logger = new Logger();
    });

    test('should create instance with log function', () => {
      expect(logger.log).toBeDefined();
    });

    test('should log event with trace', () => {
      const event = {
        detail: {
          action: 'test_action',
          message: 'Test message'
        }
      };

      logger.event('corr-123', 'info', event);

      expect(console.log).toHaveBeenCalledWith(JSON.stringify({
        timestamp: expect.any(String),
        event,
        correlationId: 'corr-123',
        status: 'INFO',
        message: 'test_action'
      }));
    });

    test('should log status', () => {
      logger.status('corr-123', 'action', 'status');

      expect(console.log).toHaveBeenCalledWith(JSON.stringify({
        timestamp: expect.any(String),
        event: {
          detail: { action: 'action', status: 'status' }
        },
        correlationId: 'corr-123',
        status: 'STATUS'
      }));
    });

    test('should log error', () => {
      const error = new Error('Test error');

      logger.error('corr-123', 'action', error);

      expect(console.error).toHaveBeenCalledWith(JSON.stringify({
        timestamp: expect.any(String),
        event: {
          detail: { action: 'action', error: 'Test error' }
        },
        correlationId: 'corr-123',
        status: 'ERROR',
        message: 'Test error'
      }));
    });

    test('should trace action and measure duration', () => {
      const callback = jest.fn();

      logger.trace('corr-123', 'test_action', callback);

      assert.strictEqual(callback.mock.calls.length, 1);
      expect(console.log).toHaveBeenCalledWith(JSON.stringify(
        expect.objectContaining({
          event: expect.objectContaining({
            detail: expect.objectContaining({
              action: 'test_action',
              duration: expect.stringMatching(/\d+ms/)
            })
          })
        })
      ));
    });

    test('should trace and throw error', () => {
      const error = new Error('Test error');
      const callback = jest.fn(() => { throw error; });

      expect(() => {
        logger.trace('corr-123', 'test_action', callback);
      }).toThrow(error);

      expect(console.error).toHaveBeenCalledWith(JSON.stringify(
        expect.objectContaining({
          event: expect.objectContaining({
            detail: { action: 'test_action', error: 'Test error' }
          })
        })
      ));
    });
  });
});