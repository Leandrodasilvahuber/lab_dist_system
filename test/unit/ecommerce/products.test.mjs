import { handler } from '../../../src/ecommerce/products/index.mjs';

// Mock setup manually for Node.js test runner
import { createMock } from '../../../test/test-utils.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert';

describe('Products Service Handler', () => {
  const mockSetupRoutes = createMock();

  describe('GET /products', () => {
    test('should return list of products', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({
          products: [
            { id: '1', name: 'Product 1', price: 100 },
            { id: '2', name: 'Product 2', price: 200 }
          ]
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'GET',
        path: '/products',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 200);
      assert(result.body.includes('products'));
    });

    test('should filter products by category', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({
          products: [
            { id: '1', name: 'Product 1', category: 'electronics' }
          ]
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'GET',
        path: '/products?category=electronics',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 200);
    });
  });

  describe('GET /products/{id}', () => {
    test('should return product details', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({
          id: '1',
          name: 'Product 1',
          price: 100,
          stock: 50
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'GET',
        path: '/products/1',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 200);
      assert(result.body.includes('Product 1'));
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
        httpMethod: 'GET',
        path: '/products/999',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 404);
    });
  });

  describe('POST /products', () => {
    test('should create new product', async () => {
      const mockResponse = {
        statusCode: 201,
        body: JSON.stringify({
          id: 'product-123',
          name: 'New Product',
          price: 150,
          stock: 100
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/products',
        headers: {
          correlationId: 'test-correlation',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'New Product',
          price: 150,
          stock: 100
        })
      };

      const result = await handler(event);

      assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 201);
      assert(result.body.includes('product-123'));
    });

    test('should return 400 for invalid product data', async () => {
      const mockResponse = {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Invalid product data'
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'POST',
        path: '/products',
        headers: {
          correlationId: 'test-correlation',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'Product without price'
          // Missing required fields
        })
      };

      const result = await handler(event);

      assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 400);
    });
  });

  describe('PUT /products/{id}', () => {
    test('should update product details', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({
          id: '1',
          name: 'Updated Product',
          price: 120,
          stock: 80
        })
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'PUT',
        path: '/products/1',
        headers: {
          correlationId: 'test-correlation',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          price: 120,
          stock: 80
        })
      };

      const result = await handler(event);

      assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 200);
    });
  });

  describe('DELETE /products/{id}', () => {
    test('should delete product', async () => {
      const mockResponse = {
        statusCode: 204,
        body: ''
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'DELETE',
        path: '/products/1',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      assert(mockSetupRoutes.mock.calls.length === 1 expect(mockSetupRoutes).toHaveBeenCalledWith(event)expect(mockSetupRoutes).toHaveBeenCalledWith(event) mockSetupRoutes.mock.calls[0][0] === event);
      assert.strictEqual(result.statusCode, 204);
    });
  });

  describe('Error Handling', () => {
    test('should handle internal server error', async () => {
      mockSetupRoutes.mockImplementation(() => {
        throw new Error('Database error');
      });

      const event = {
        httpMethod: 'GET',
        path: '/products',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      assert.strictEqual(result.statusCode, 500);
      assert(result.body.includes('Internal server error'));
    });

    test('should handle timeout errors', async () => {
      mockSetupRoutes.mockImplementation(() => {
        throw new Error('Request timeout');
      });

      const event = {
        httpMethod: 'GET',
        path: '/products',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      assert.strictEqual(result.statusCode, 500);
    });
  });

  describe('CORS Headers', () => {
    test('should include proper CORS headers', async () => {
      const mockResponse = {
        statusCode: 200,
        body: JSON.stringify({ products: [] }),
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };

      mockSetupRoutes.mockReturnValue(mockResponse);

      const event = {
        httpMethod: 'GET',
        path: '/products',
        headers: { correlationId: 'test-correlation' }
      };

      const result = await handler(event);

      expect(result.headers).toBeDefined();
      assert.strictEqual(result.headers['Access-Control-Allow-Origin'], '*');
      assert.strictEqual(result.headers['Content-Type'], 'application/json');
    });
  });
});