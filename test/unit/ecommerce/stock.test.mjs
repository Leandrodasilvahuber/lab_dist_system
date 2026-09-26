import { handler } from '../../../src/ecommerce/stock/index.mjs';
import { jest } from 'jest';

// Mocks
jest.mock('../../../src/ecommerce/stock/src/routes/stockRoutes.js');

describe('Stock Service Handler', () => {
  const mockSetupRoutes = require('../../../src/ecommerce/stock/src/routes/stockRoutes.js').setupRoutes;

  beforeEach(() => {
    jest.clearAllMocks();
  });

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

      expect(mockSetupRoutes).toHaveBeenCalledWith(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('success: true');
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

      expect(mockSetupRoutes).toHaveBeenCalledWith(event);
      expect(result.statusCode).toBe(400);
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

      expect(mockSetupRoutes).toHaveBeenCalledWith(event);
      expect(result.statusCode).toBe(404);
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

      expect(mockSetupRoutes).toHaveBeenCalledWith(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('success: true');
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

      expect(result.statusCode).toBe(500);
      expect(result.body).toContain('Internal server error');
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

      expect(result.statusCode).toBe(500);
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

      expect(result.headers).toBeDefined();
      expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
    });
  });
});