import { handler } from '../../../src/ecommerce/stock/index.mjs';

// Mock setup manually for Node.js test runner
import { createMock } from '../../../test/test-utils.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert';

describe('Stock Service Handler', () => {
  const mockSetupRoutes = createMock();

  describe('POST /stock/reserve', () => {
    test('should reserve stock for order', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          reserved: 10
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/stock/reserve',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({
          orderId: 'order-123',
          productId: 'product-1',
          quantity: 10
        })
      };

      const result = await handler(event);

      assert.strictEqual(mockSetupRoutes.mock.calls.length, 1); assert(mockSetupRoutes.mock.calls[0] assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event)assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 200);
      assert(result.body.includes('success: true'));
    });

    test('should return 400 for insufficient stock', async () => {
      const mockResponse = {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Insufficient stock',
          available: 5,
          requested: 10
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/stock/reserve',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({
          orderId: 'order-123',
          productId: 'product-1',
          quantity: 10
        })
      };

      const result = await handler(event);

      assert.strictEqual(mockSetupRoutes.mock.calls.length, 1); assert(mockSetupRoutes.mock.calls[0] assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event)assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 400);
    });

    test('should return 404 for non-existent product', async () => {
      const mockResponse = {
        statusCode: 404,
        body: JSON.stringify({
          error: 'Product not found'
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/stock/reserve',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({
          orderId: 'order-123',
          productId: '999',
          quantity: 10
        })
      };

      const result = await handler(event);

      assert.strictEqual(mockSetupRoutes.mock.calls.length, 1); assert(mockSetupRoutes.mock.calls[0] assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event)assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 404);
    });
  });

  describe('POST /stock/release', () => {
    test('should release reserved stock', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          released: 10
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/stock/release',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({
          orderId: 'order-123',
          productId: 'product-1',
          quantity: 10
        })
      };

      const result = await handler(event);

      assert.strictEqual(mockSetupRoutes.mock.calls.length, 1); assert(mockSetupRoutes.mock.calls[0] assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event)assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 200);
      assert(result.body.includes('success: true'));
    });
  });

  describe('Error Handling', () => {
    test('should handle database error', async () => {
      mockSetupRoutes.mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const event = {
        httpMethod: 'POST',
        path: '/stock/reserve',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({
          orderId: 'order-123',
          productId: 'product-1',
          quantity: 10
        })
      };

      const result = await handler(event);

      assert.strictEqual(result.statusCode, 500);
      assert(result.body.includes('Internal server error'));
    });

    test('should handle invalid quantity', async () => {
      mockSetupRoutes.mockImplementation(() => {
        throw new Error('Invalid quantity');
      });

      const event = {
        httpMethod: 'POST',
        path: '/stock/reserve',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({
          orderId: 'order-123',
          productId: 'product-1',
          quantity: -5
        })
      };

      const result = await handler(event);

      assert.strictEqual(result.statusCode, 500);
    });
  });

  describe('CORS Headers', () => {
    test('should include CORS headers', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({ success: true }),
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/stock/reserve',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({
          orderId: 'order-123',
          productId: 'product-1',
          quantity: 10
        })
      };

      const result = await handler(event);

      assert(result.headers !== undefined);
      assert.strictEqual(result.headers['Access-Control-Allow-Origin'], '*');
    });
  });
});