// Test utilities for the distributed systems playground

// Mock utilities for Node.js test runner
export function spyOn(object, method) {
  const originalMethod = object[method].bind(object)

  const mockFn = (...args) => {
    return originalMethod(...args)
  }

  // Track call count and calls
  mockFn.mockCallCount = 0
  mockFn.mockCalls = []
  mockFn.mockResolvedValues = []
  mockFn.mockRejectedValues = []

  // Mock implementations
  mockFn.mockImplementation = (implementation) => {
    object[method] = implementation.bind(object)
  }

  mockFn.mockResolvedValue = (value) => {
    object[method] = async (...args) => {
      mockFn.mockCallCount++
      mockFn.mockCalls.push([...args])
      return value
    }
  }

  mockFn.mockResolvedValueOnce = (value) => {
    let calledOnce = false
    object[method] = async (...args) => {
      if (!calledOnce) {
        calledOnce = true
        mockFn.mockCallCount++
        mockFn.mockCalls.push([...args])
        return value
      }
      return originalMethod(...args)
    }
  }

  mockFn.mockRejectedValue = (value) => {
    object[method] = async (...args) => {
      mockFn.mockCallCount++
      mockFn.mockCalls.push([...args])
      throw value
    }
  }

  mockFn.mockRejectedValueOnce = (value) => {
    let calledOnce = false
    object[method] = async (...args) => {
      if (!calledOnce) {
        calledOnce = true
        mockFn.mockCallCount++
        mockFn.mockCalls.push([...args])
        throw value
      }
      return originalMethod(...args)
    }
  }

  mockFn.mockReturnValue = (value) => {
    object[method] = (...args) => {
      mockFn.mockCallCount++
      mockFn.mockCalls.push([...args])
      return value
    }
  }

  mockFn.mockReturnValueOnce = (value) => {
    let calledOnce = false
    object[method] = (...args) => {
      if (!calledOnce) {
        calledOnce = true
        mockFn.mockCallCount++
        mockFn.mockCalls.push([...args])
        return value
      }
      return originalMethod(...args)
    }
  }

  // Utility methods
  mockFn.mockClear = () => {
    mockFn.mockCallCount = 0
    mockFn.mockCalls = []
    mockFn.mockResolvedValues = []
    mockFn.mockRejectedValues = []
  }

  mockFn.mockReset = () => {
    mockFn.mockClear()
  }

  mockFn.mockRestore = () => {
    object[method] = originalMethod
    mockFn.mockClear()
  }

  mockFn.mockImplementationOnce = (implementation) => {
    const mockImpl = async (...args) => {
      mockFn.mockCallCount++
      mockFn.mockCalls.push([...args])
      return implementation(...args)
    }
    object[method] = mockImpl
  }

  // Initialize
  mockFn.mockCallCount = 0
  mockFn.mockCalls = []

  return mockFn
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
    getItem: jest.fn(),
    putItem: jest.fn(),
    updateItem: jest.fn(),
    queryItems: jest.fn(),
    scanItems: jest.fn()
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