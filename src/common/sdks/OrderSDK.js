import { Database } from '../../database.mjs';

/**
 * SDK Público - Interface uniforme para operações de pedido
 */
export class OrderSDK {
  constructor(eventBridgeClient) {
    this.eventBridgeClient = eventBridgeClient;
  }

  /**
   * Criar pedido
   */
  async createOrder(orderData) {
    const correlationId = orderData.correlationId || generateCorrelationId();

    // Calcular total
    const product = await Database.get('Products', orderData.productId);
    if (!product) {
      throw new Error('Product not found');
    }

    const total = product.price * orderData.quantity;

    const order = {
      id: generateId(),
      productId: orderData.productId,
      quantity: orderData.quantity,
      total: total,
      status: 'pending', // pending, confirmed, paid, cancelled
      correlationId: correlationId,
      createdAt: new Date().toISOString()
    };

    await Database.put('Orders', order.id, order);
    return order;
  }

  /**
   * Buscar pedido por ID
   */
  async getOrder(orderId) {
    const order = await Database.get('Orders', orderId);
    if (!order) {
      throw new Error('Order not found');
    }
    return order;
  }

  /**
   * Cancelar pedido
   */
  async cancelOrder(orderId, correlationId) {
    const order = await this.getOrder(orderId);

    if (order.status === 'cancelled' || order.status === 'completed') {
      throw new Error(`Cannot cancel ${order.status} order`);
    }

    order.status = 'cancelled';
    order.updatedAt = new Date().toISOString();
    await Database.put('Orders', orderId, order);

    // Em produção, publicar evento
    if (this.eventBridgeClient) {
      await this.eventBridgeClient.publish({
        Source: 'orders',
        DetailType: 'OrderCancelled',
        Detail: JSON.stringify({
          orderId,
          correlationId
        })
      });
    }

    return order;
  }

  /**
   * Listar pedidos
   */
  async listOrders(filters = {}) {
    const allOrders = await Database.scan('Orders');
    return allOrders.filter(order => {
      if (filters.status && order.status !== filters.status) {
        return false;
      }
      if (filters.productId && order.productId !== filters.productId) {
        return false;
      }
      if (filters.correlationId && order.correlationId !== filters.correlationId) {
        return false;
      }
      return true;
    });
  }
}

/**
 * Gerar ID único
 */
function generateId() {
  return `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Gerar ID de correlação
 */
function generateCorrelationId() {
  return `corr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}