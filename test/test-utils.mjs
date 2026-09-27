// Test utilities for the distributed systems playground

// Mock utilities for Node.js test runner

// Simple mock implementation for Node.js test runner
export function createMock() {
  const mockFn = (...args) => {
    mockFn.mockCalls.push(args);
    return mockFn.mockImplementation
      ? mockFn.mockImplementation(...args)
      : Promise.resolve(undefined);
  };

  mockFn.mockCalls = [];
  mockFn.mockImplementation = (fn) => {
    mockFn.fn = fn;
    return mockFn;
  };

  mockFn.mockResolvedValue = (value) => {
    mockFn.fn = () => Promise.resolve(value);
    return mockFn;
  };

  mockFn.mockRejectedValue = (value) => {
    mockFn.fn = () => Promise.reject(value);
    return mockFn;
  };

  mockFn.mockReturnValue = (value) => {
    mockFn.fn = () => value;
    return mockFn;
  };

  mockFn.mockClear = () => {
    mockFn.mockCalls = [];
    return mockFn;
  };

  mockFn.mockReset = () => {
    mockFn.mockCalls = [];
    delete mockFn.fn;
    return mockFn;
  };

  return mockFn;
}

// Global mock function
export function spyOn(object, methodName) {
  const originalMethod = object[methodName];
  const mockFn = createMock();

  object[methodName] = mockFn;

  // Restore function
  mockFn.mockRestore = () => {
    object[methodName] = originalMethod;
    mockFn.mockReset();
  };

  return mockFn;
}

// Mock event generators
export const generateMockEvent = (method, path, body = null, pathParams = {}) => ({
  httpMethod: method,
  path: path,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  },
  body: body ? JSON.stringify(body) : null,
  pathParameters: pathParams
})

// Database mock helpers
export const setupDatabase = (items = {}) => {
  const mockDatabase = {
    getItem: createMock(),
    putItem: createMock(),
    updateItem: createMock(),
    queryItems: createMock(),
    scanItems: createMock()
  }

  // Setup default mock responses
  mockDatabase.getItem.mockImplementation((table, key) => {
    const item = items[`${table}_${key}`]
    return Promise.resolve(item ? { Item: item } : {})
  })

  mockDatabase.scanItems.mockImplementation((table) => {
    const tableItems = Object.entries(items)
      .filter(([key]) => key.startsWith(`${table}_`))
      .map(([_, value]) => value)
    return Promise.resolve({ Items: tableItems })
  })

  return mockDatabase
}

// Common test data
export const testProduct = {
  id: 'test-product-id',
  name: 'Test Product',
  price: 19.99,
  stock: 100,
  reserved: 0,
  ordersInProgress: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}

export const testOrder = {
  id: 'test-order-id',
  productId: 'test-product-id',
  quantity: 2,
  total: 39.98,
  status: 'ORDER_CREATED',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}

export const testPayment = {
  id: 'test-payment-id',
  orderId: 'test-order-id',
  amount: 39.98,
  status: 'PENDING',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}