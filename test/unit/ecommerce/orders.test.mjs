import { handler } from '../../../src/ecommerce/orders/index.mjs';
import { jest } from 'jest';

// Mocks
jest.mock('../../../src/ecommerce/orders/src/routes/orderRoutes.js');

describe('Orders Service Handler', () => {
  const mockSetupRoutes = require('../../../src/ecommerce/orders/src/routes/orderRoutes.js').setupRoutes;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /orders', () => {
    test('should return list of orders', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({
          orders: [
            { id: '1', total: 100, status: 'pending' }
          ]
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'GET',
        path: '/orders',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      expect(mockSetupRoutes).toHaveBeenCalledWith(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('orders');
    });
  });

  describe('POST /orders', () => {
    test('should create a new order', async () => {
      const mockResponse = {
        statusCode: 201,
        body: JSON.stringify({
          id: 'order-123',
          status: 'pending'
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/orders',
        headers: { correlationId: 'test-correlation' },
        body: JSON.stringify({
          products: [{ id: '1', quantity: 2 }]
        })
      };

      const result = await handler(event);

      expect(mockSetupRoutes).toHaveBeenCalledWith(event);
      expect(result.statusCode).toBe(201);
      expect(result.body).toContain('order-123');
    });
  });

  describe('GET /orders/{id}', () => {
    test('should return order details', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({
          id: 'order-123',
          status: 'confirmed',
          total: 200
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'GET',
        path: '/orders/order-123',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      expect(mockSetupRoutes).toHaveBeenCalledWith(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('order-123');
    });
  });

  describe('POST /orders/{id}/pay', () => {
    test('should process payment for order', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({
          paymentId: 'pay-123',
          status: 'approved'
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/orders/order-123/pay',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      expect(mockSetupRoutes).toHaveBeenCalledWith(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('paymentId: 'pay-123'');
    });
  });

  describe('POST /orders/{id}/cancel', () => {
    test('should cancel order', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({
          id: 'order-123',
          status: 'cancelled'
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/orders/order-123/cancel',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      expect(mockSetupRoutes).toHaveBeenCalledWith(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('cancelled');
    });
  });

  describe('Error Handling', () => {
    test('should handle internal server error', async () => {
      mockSetupRoutes.mockImplementation(() => {
        throw new Error('Internal server error');
      });

      const event = {
        httpMethod: 'GET',
        path: '/orders',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(result.body).toContain('Internal server error');
    });

    test('should log errors with correlationId', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      mockSetupRoutes.mockImplementation(() => {
        throw new Error('Test error');
      });

      const event = {
        httpMethod: 'GET',
        path: '/orders',
        headers: { correlationId: 'test-correlation' }
      };

      await handler(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('test-correlation')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('CORS Headers', () => {
    test('should include CORS headers in response', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({ message: 'success' }),
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': true
        }
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'GET',
        path: '/orders',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      expect(result.headers).toBeDefined();
      expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(result.headers['Access-Control-Allow-Credentials']).toBe('true');
    });
  });
});