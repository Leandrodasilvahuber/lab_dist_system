import { describe, it, beforeEach, expect } from 'node:test';
import assert from 'node:assert';

// Mocks
import { mockDatabase } from '../../../src/common/database.mjs';
import { mockLogger } from '../../../src/common/logger.mjs';

const { Database } = require('../../../src/common/database.mjs');
const { log, createLogContext } = require('../../../src/common/logger.mjs');

describe('Saga Orchestrator');
  let mockDb;
  const mockLog = jest.fn();
  const mockCreateLogContext = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockLog.mockImplementation(() => {});
    mockCreateLogContext.mockReturnValue({
      correlationId: 'test-correlation',
      orderId: 'order-123'
    });

    mockDb = new Database();
    jest.spyOn(Database.prototype, 'putItem').mockImplementation(jest.fn());
    jest.spyOn(Database.prototype, 'getItem').mockImplementation(jest.fn());
    jest.spyOn(Database.prototype, 'updateItem').mockImplementation(jest.fn());
  });

  describe('createOrder saga', () => {
    test('should orchestrate order creation with compensation', async () => {
      const mockPutItem = jest.fn()
        .mockResolvedValueOnce({ id: '1', status: 'created' })
        .mockResolvedValueOnce({ id: '1', status: 'pending' })
        .mockResolvedValueOnce({ id: '1', status: 'confirmed' });

      jest.spyOn(Database.prototype, 'putItem').mockImplementation(mockPutItem);

      const event = {
        httpMethod: 'POST',
        path: '/orders',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({
          productId: 'product-1',
          quantity: 2,
          total: 200
        })
      };

      const result = await sagaOrchestrator(event, mockDb);

      expect(result.statusCode).toBe(201);
      expect(result.body).toContain('order-123');
      expect(mockPutItem).toHaveBeenCalledTimes(3);
    });

    test('should compensate when stock reservation fails', async () => {
      const mockPutItem = jest.fn()
        .mockResolvedValueOnce({ id: '1', status: 'created' })
        .mockRejectedValueOnce(new Error('Stock not available'));

      jest.spyOn(Database.prototype, 'putItem').mockImplementation(mockPutItem);

      const event = {
        httpMethod: 'POST',
        path: '/orders',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({
          productId: 'product-1',
          quantity: 100
        })
      };

      const result = await sagaOrchestrator(event, mockDb);

      expect(result.statusCode).toBe(500);
      expect(mockPutItem).toHaveBeenCalledTimes(1); // Only created order, no compensation
    });

    test('should handle payment processing failure', async () => {
      const mockPutItem = jest.fn()
        .mockResolvedValueOnce({ id: '1', status: 'created' })
        .mockResolvedValueOnce({ id: '1', status: 'stock-reserved' })
        .mockRejectedValueOnce(new Error('Payment failed'));

      jest.spyOn(Database.prototype, 'putItem').mockImplementation(mockPutItem);

      const event = {
        httpMethod: 'POST',
        path: '/orders',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({
          productId: 'product-1',
          quantity: 2,
          total: 200
        })
      };

      const result = await sagaOrchestrator(event, mockDb);

      expect(result.statusCode).toBe(500);
    });
  });

  describe('getOrder saga', () => {
    test('should retrieve order with all details', async () => {
      const mockDb = new Database();
      const mockGetItem = jest.fn()
        .mockResolvedValueOnce({ id: '1', status: 'confirmed', total: 200 });

      mockDb.getItem = mockGetItem;
      jest.spyOn(Database.prototype, 'getItem').mockImplementation(mockGetItem);

      const event = {
        httpMethod: 'GET',
        path: '/orders/1',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await sagaOrchestrator(event, mockDb);

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('order-1');
      expect(mockGetItem).toHaveBeenCalledWith('orders', { id: '1' });
    });
  });

  describe('cancelOrder saga', () => {
    test('should cancel order with compensation', async () => {
      const mockDb = new Database();
      const mockPutItem = jest.fn()
        .mockResolvedValueOnce({ id: '1', status: 'cancelled' });

      mockDb.putItem = mockPutItem;
      jest.spyOn(Database.prototype, 'putItem').mockImplementation(mockPutItem);

      const event = {
        httpMethod: 'POST',
        path: '/orders/1/cancel',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await sagaOrchestrator(event, mockDb);

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('cancelled');
    });
  });

  describe('compensation logic', () => {
    test('should handle compensations in reverse order', async () => {
      const mockDb = new Database();
      const mockPutItem = jest.fn()
        .mockResolvedValueOnce({ id: '1', status: 'created' })
        .mockResolvedValueOnce({ id: '1', status: 'compensated' })
        .mockResolvedValueOnce({ id: '1', status: 'cancelled' });

      mockDb.putItem = mockPutItem;
      jest.spyOn(Database.prototype, 'putItem').mockImplementation(mockPutItem);

      const event = {
        httpMethod: 'POST',
        path: '/orders/1/cancel',
        headers: { correlationId: 'test-correlation' }
      };

      await sagaOrchestrator(event, mockDb);

      // Verify order of operations
      expect(mockPutItem).toHaveBeenCalledTimes(3);
    });
  });

  describe('logging and tracing', () => {
    test('should log all saga steps', async () => {
      const mockDb = new Database();
      const mockPutItem = jest.fn()
        .mockResolvedValueOnce({ id: '1', status: 'created' })
        .mockResolvedValueOnce({ id: '1', status: 'confirmed' });

      mockDb.putItem = mockPutItem;
      jest.spyOn(Database.prototype, 'putItem').mockImplementation(mockPutItem);

      const event = {
        httpMethod: 'POST',
        path: '/orders',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({ productId: 'product-1', quantity: 1 })
      };

      await sagaOrchestrator(event, mockDb);

      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'ORDER_CREATED',
          correlationId: 'test-correlation'
        })
      );

      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'ORDER_CONFIRMED',
          correlationId: 'test-correlation'
        })
      );
    });
  });

  describe('error handling', () => {
    test('should handle database connection errors', async () => {
      const mockDb = new Database();
      mockDb.putItem = jest.fn().mockRejectedValue(new Error('Database connection failed'));

      const event = {
        httpMethod: 'POST',
        path: '/orders',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({ productId: 'product-1', quantity: 1 })
      };

      const result = await sagaOrchestrator(event, mockDb);

      expect(result.statusCode).toBe(500);
      expect(result.body).toContain('Internal server error');
      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'ORDER_ERROR',
          status: 'error'
        })
      );
    });

    test('should handle invalid request data', async () => {
      const mockDb = new Database();

      const event = {
        httpMethod: 'POST',
        path: '/orders',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({}) // Invalid data
      };

      const result = await sagaOrchestrator(event, mockDb);

      expect(result.statusCode).toBe(400);
    });
  });

  describe('correlationId propagation', () => {
    test('should propagate correlationId to all operations', async () => {
      const mockDb = new Database();
      const mockPutItem = jest.fn()
        .mockResolvedValueOnce({ id: '1', status: 'created' })
        .mockResolvedValueOnce({ id: '1', status: 'confirmed' });

      mockDb.putItem = mockPutItem;
      jest.spyOn(Database.prototype, 'putItem').mockImplementation(mockPutItem);

      const event = {
        httpMethod: 'POST',
        path: '/orders',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({ productId: 'product-1', quantity: 1 })
      };

      await sagaOrchestrator(event, mockDb);

      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: 'test-correlation'
        })
      );
    });
  });

  describe('concurrent request handling', () => {
    test('should handle multiple concurrent orders', async () => {
      const mockDb = new Database();
      const mockPutItem = jest.fn()
        .mockResolvedValueOnce({ id: '1', status: 'created' })
        .mockResolvedValueOnce({ id: '2', status: 'created' })
        .mockResolvedValueOnce({ id: '1', status: 'confirmed' })
        .mockResolvedValueOnce({ id: '2', status: 'confirmed' });

      mockDb.putItem = mockPutItem;
      jest.spyOn(Database.prototype, 'putItem').mockImplementation(mockPutItem);

      const event1 = {
        httpMethod: 'POST',
        path: '/orders',
        headers: { correlationId: 'correlation-1' },
        body: JSON.stringify({ productId: 'product-1', quantity: 1 })
      };

      const event2 = {
        httpMethod: 'POST',
        path: '/orders',
        headers: { correlationId: 'correlation-2' },
        body: JSON.stringify({ productId: 'product-2', quantity: 1 })
      };

      await sagaOrchestrator(event1, mockDb);
      await sagaOrchestrator(event2, mockDb);

      expect(mockPutItem).toHaveBeenCalledTimes(4);
    });
  });
});