import { handler } from '../../../src/ecommerce/payments/index.mjs';

// Mock setup manually for Node.js test runner
import { createMock } from '../../../test/test-utils.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert';

describe('Payments Service Handler', () => {
  const mockSetupRoutes = createMock();

  describe('POST /payments/{id}/cancel', () => {
    test('should cancel payment', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({
          paymentId: 'pay-123',
          status: 'cancelled'
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/payments/pay-123/cancel',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 200);
      assert(result.body.includes('cancelled'));
    });

    test('should return 404 for non-existent payment', async () => {
      const mockResponse = {
        statusCode: 404,
        body: JSON.stringify({
          error: 'Payment not found'
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/payments/999/cancel',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 404);
    });
  });

  describe('Error Handling', () => {
    test('should handle payment processing error', async () => {
      mockSetupRoutes.mockImplementation(() => {
        throw new Error('Payment processing failed');
      });

      const event = {
        httpMethod: 'POST',
        path: '/payments/pay-123/cancel',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      assert.strictEqual(result.statusCode, 500);
      assert(result.body.includes('Internal server error'));
    });

    test('should handle validation error', async () => {
      mockSetupRoutes.mockImplementation(() => {
        throw new Error('Invalid payment ID');
      });

      const event = {
        httpMethod: 'POST',
        path: '/payments/invalid-cancel',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      assert.strictEqual(result.statusCode, 500);
    });
  });

  describe('CORS Headers', () => {
    test('should include CORS headers', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({ status: 'cancelled' }),
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/payments/pay-123/cancel',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      expect(result.headers).toBeDefined();
      assert.strictEqual(result.headers['Access-Control-Allow-Origin'], '*');
    });
  });
});