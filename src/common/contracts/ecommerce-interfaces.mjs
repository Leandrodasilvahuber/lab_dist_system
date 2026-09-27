/**
 * Contratos entre serviços - contrato de interface
 */
export const EcommerceInterfaces = {
  Product: {
    createProduct: {
      input: { name, price, description, stock },
      output: { id, name, price, description, stock }
    },
    getProduct: {
      input: { productId },
      output: { id, name, price, description, stock }
    },
    listProducts: {
      input: { filters },
      output: { products: [{ id, name, price, description, stock }] }
    },
    updateProduct: {
      input: { productId, updates },
      output: { id, name, price, description, stock }
    },
    deleteProduct: {
      input: { productId },
      output: { success }
    }
  },
  Order: {
    createOrder: {
      input: { productId, quantity, correlationId },
      output: { id, status, total, createdAt }
    },
    getOrder: {
      input: { orderId },
      output: { id, productId, quantity, status, total, createdAt }
    },
    cancelOrder: {
      input: { orderId, correlationId },
      output: { id, status }
    },
    listOrders: {
      input: { filters },
      output: { orders: [{ id, productId, status, total, createdAt }] }
    }
  },
  Payment: {
    processPayment: {
      input: { orderId, amount, correlationId },
      output: { id, status, transactionId, processedAt }
    },
    refundPayment: {
      input: { transactionId, amount, correlationId },
      output: { id, success, refundedAt }
    },
    getPayment: {
      input: { paymentId },
      output: { id, orderId, amount, status, transactionId }
    }
  },
  Stock: {
    reserveStock: {
      input: { productId, quantity, correlationId },
      output: { success, reservedQuantity, expiresAt }
    },
    releaseStock: {
      input: { productId, quantity, correlationId },
      output: { success }
    },
    getStock: {
      input: { productId },
      output: { productId, available, reserved, reservedBy }
    },
    listStock: {
      input: { filters },
      output: { stock: [{ productId, available, reserved }] }
    }
  }
};