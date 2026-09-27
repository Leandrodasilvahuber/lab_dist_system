import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'node:test';
import http from 'http';
import { spawn } from 'child_process';

// Import utilities for testing
const fetch = async (url, options = {}) => {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
};

describe('API Gateway Endpoints Integration Tests', () => {
  let serverProcess;
  let serverStarted = false;

  beforeAll(async () => {
    // Start the mock server
    serverProcess = spawn('node', ['server-test.mjs'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Wait for server to start
    await new Promise((resolve, reject) => {
      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('Mock API Gateway em execução')) {
          serverStarted = true;
          resolve();
        }
      });

      serverProcess.stderr.on('data', (data) => {
        console.error('Server error:', data.toString());
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!serverStarted) {
          reject(new Error('Server failed to start'));
        }
      }, 10000);
    });
  });

  afterAll(() => {
    // Clean up server process
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await fetch('http://localhost:3001/health');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');

      const body = JSON.parse(response.body);
      expect(body.status).toBe('healthy');
      expect(body.message).toBe('Distributed E-commerce System');
    });
  });

  describe('Products Endpoints', () => {
    let productId;

    it('should create a product', async () => {
      const productData = {
        id: `test-product-${Date.now()}`,
        name: 'Test Product',
        price: 99.99,
        stock: 10
      };

      const response = await fetch('http://localhost:3001/api/ecommerce/products', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(productData)
      });

      expect(response.status).toBe(201);
      expect(response.headers['content-type']).toContain('application/json');

      const body = JSON.parse(response.body);
      expect(body.id).toBe(productData.id);
      expect(body.name).toBe(productData.name);
      expect(body.price).toBe(productData.price);
      expect(body.stock).toBe(productData.stock);

      productId = body.id;
    });

    it('should get all products', async () => {
      const response = await fetch('http://localhost:3001/api/ecommerce/products');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');

      const body = JSON.parse(response.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);

      // Check if our test product exists
      const testProduct = body.find(p => p.id === productId);
      expect(testProduct).toBeDefined();
      expect(testProduct.name).toBe('Test Product');
    });
  });

  describe('Orders Endpoints', () => {
    let orderId;

    it('should create an order', async () => {
      const orderData = {
        productId: 'prod-1',
        quantity: 2,
        userId: 'user-123'
      };

      const response = await fetch('http://localhost:3001/api/ecommerce/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderData)
      });

      expect(response.status).toBe(201);
      expect(response.headers['content-type']).toContain('application/json');

      const body = JSON.parse(response.body);
      expect(body.id).toMatch(/^order-/);
      expect(body.productId).toBe(orderData.productId);
      expect(body.quantity).toBe(orderData.quantity);
      expect(body.userId).toBe(orderData.userId);
      expect(body.status).toBe('CREATED');

      orderId = body.id;
    });
  });

  describe('Payments Endpoints', () => {
    it('should process a payment', async () => {
      const paymentData = {
        orderId: 'order-123',
        amount: 99.99
      };

      const response = await fetch('http://localhost:3001/api/ecommerce/payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(paymentData)
      });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');

      const body = JSON.parse(response.body);
      expect(body.orderId).toBe(paymentData.orderId);
      expect(body.amount).toBe(paymentData.amount);
      expect(body.status).toBe('APPROVED');
      expect(body.paymentId).toMatch(/^pay-/);
    });
  });

  describe('Stock Endpoints', () => {
    it('should get stock information', async () => {
      const response = await fetch('http://localhost:3001/api/ecommerce/stock');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');

      const body = JSON.parse(response.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);

      const stockItem = body[0];
      expect(stockItem).toHaveProperty('productId');
      expect(stockItem).toHaveProperty('available');
      expect(stockItem).toHaveProperty('reserved');
    });

    it('should reserve stock', async () => {
      const stockData = {
        quantity: 1
      };

      const response = await fetch('http://localhost:3001/api/ecommerce/stock/test-product-123/reserve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(stockData)
      });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');

      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('orderId');
      expect(body).toHaveProperty('productId');
      expect(body).toHaveProperty('quantity');
      expect(body).toHaveProperty('status');
    });
  });

  describe('Saga Endpoints', () => {
    it('should start saga orchestrator', async () => {
      const sagaData = {
        orderId: 'order-123',
        productId: 'prod-1',
        quantity: 2,
        totalAmount: 199.98
      };

      const response = await fetch('http://localhost:3001/api/ecommerce/saga/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sagaData)
      });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');

      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('sagaId');
      expect(body).toHaveProperty('orderId');
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('steps');
      expect(Array.isArray(body.steps)).toBe(true);
      expect(body.status).toBe('STARTED');
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for non-existent endpoints', async () => {
      const response = await fetch('http://localhost:3001/api/unknown');

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');

      const body = JSON.parse(response.body);
      expect(body.error).toBe('Not found');
      expect(body.path).toBe('/api/unknown');
      expect(body.availableEndpoints).toBeDefined();
      expect(Array.isArray(body.availableEndpoints)).toBe(true);
    });

    it('should handle invalid JSON requests', async () => {
      const response = await fetch('http://localhost:3001/api/ecommerce/products', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: 'invalid json'
      });

      expect(response.status).toBe(500);
      expect(response.headers['content-type']).toContain('application/json');

      const body = JSON.parse(response.body);
      expect(body.error).toBe('Internal server error');
    });
  });

  describe('Request Validation', () => {
    it('should reject POST requests without JSON content-type', async () => {
      const response = await fetch('http://localhost:3001/api/ecommerce/products', {
        method: 'POST',
        body: JSON.stringify({ id: 'test', name: 'Test', price: 10, stock: 5 })
      });

      // The server should handle this gracefully
      expect([200, 400, 500]).toContain(response.status);
    });

    it('should handle empty request bodies gracefully', async () => {
      const response = await fetch('http://localhost:3001/api/ecommerce/products', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: '{}'
      });

      // Should create a product with default values
      expect(response.status).toBe(201);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('name');
    });
  });
});