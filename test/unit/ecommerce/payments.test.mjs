import { handler } from '../../../src/ecommerce/payments/index.mjs';
import { jest } from 'jest';

// Mocks
jest.mock('../../../src/ecommerce/payments/src/routes/paymentRoutes.js');

describe('Payments Service Handler', () => {
  const mockSetupRoutes = require('../../../src/ecommerce/payments/src/routes/paymentRoutes.js').setupRoutes;

  beforeEach(() => {
    jest.clearAllMocks();
  });

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

      expect(mockSetupRoutes).toHaveBeenCalledWith(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('cancelled');
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

      expect(mockSetupRoutes).toHaveBeenCalledWith(event);
      expect(result.statusCode).toBe(404);
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

      expect(result.statusCode).toBe(500);
      expect(result.body).toContain('Internal server error');
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

      expect(result.statusCode).toBe(500);
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
      expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
    });
  });
});