import { Database } from '../../database.mjs';

/**
 * SDK Público - Interface uniforme para operações de estoque
 */
export class StockSDK {
  constructor(eventBridgeClient) {
    this.eventBridgeClient = eventBridgeClient;
  }

  /**
   * Reservar estoque
   */
  async reserveStock(stockData) {
    const correlationId = stockData.correlationId || generateCorrelationId();

    // Verificar disponibilidade
    const currentStock = await this.getStock(stockData.productId);
    if (currentStock.available < stockData.quantity) {
      throw new Error('Insufficient stock');
    }

    // Verificar se já existe reserva ativa
    const allReservations = await Database.scan('StockReservations');
    const activeReservation = allReservations.find(r =>
      r.productId === stockData.productId &&
      r.status === 'active' &&
      !r.expiresAt || new Date(r.expiresAt) > new Date()
    );

    if (activeReservation) {
      throw new Error('Stock already reserved for this item');
    }

    const reservation = {
      id: generateId(),
      productId: stockData.productId,
      quantity: stockData.quantity,
      status: 'active',
      correlationId: correlationId,
      reservedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutos
    };

    await Database.put('StockReservations', reservation.id, reservation);

    // Em produção, publicar evento
    if (this.eventBridgeClient) {
      await this.eventBridgeClient.publish({
        Source: 'stock',
        DetailType: 'StockReserved',
        Detail: JSON.stringify({
          reservationId: reservation.id,
          productId: stockData.productId,
          quantity: stockData.quantity,
          correlationId
        })
      });
    }

    return reservation;
  }

  /**
   * Liberar estoque
   */
  async releaseStock(stockData) {
    const correlationId = stockData.correlationId || generateCorrelationId();

    const allReservations = await Database.scan('StockReservations');
    const reservation = allReservations.find(r =>
      r.productId === stockData.productId &&
      r.status === 'active'
    );

    if (!reservation) {
      throw new Error('No active reservation found');
    }

    reservation.status = 'released';
    reservation.releasedAt = new Date().toISOString();
    await Database.put('StockReservations', reservation.id, reservation);

    return reservation;
  }

  /**
   * Buscar estoque por ID de produto
   */
  async getStock(productId) {
    // Obter do product (em produção, stock separado)
    const product = await Database.get('Products', productId);
    if (!product) {
      throw new Error('Product not found');
    }

    // Contar reservas ativas
    const allReservations = await Database.scan('StockReservations');
    const activeReservations = allReservations.filter(r =>
      r.productId === productId &&
      r.status === 'active' &&
      (!r.expiresAt || new Date(r.expiresAt) > new Date())
    );

    const totalReserved = activeReservations.reduce((sum, r) => sum + r.quantity, 0);

    return {
      productId: product.id,
      available: Math.max(0, product.stock - totalReserved),
      reserved: totalReserved,
      reservedBy: activeReservations.length
    };
  }

  /**
   * Listar estoque
   */
  async listStock(filters = {}) {
    const allProducts = await Database.scan('Products');
    const allReservations = await Database.scan('StockReservations');

    return allProducts.filter(product => {
      if (filters.productId && product.id !== filters.productId) {
        return false;
      }
      if (filters.stockMin && product.stock < filters.stockMin) {
        return false;
      }
      if (filters.stockMax && product.stock > filters.stockMax) {
        return false;
      }
      return true;
    }).map(product => {
      const activeReservations = allReservations.filter(r =>
        r.productId === product.id &&
        r.status === 'active' &&
        (!r.expiresAt || new Date(r.expiresAt) > new Date())
      );

      const totalReserved = activeReservations.reduce((sum, r) => sum + r.quantity, 0);

      return {
        productId: product.id,
        name: product.name,
        available: Math.max(0, product.stock - totalReserved),
        reserved: totalReserved
      };
    });
  }
}

/**
 * Gerar ID único
 */
function generateId() {
  return `stock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Gerar ID de correlação
 */
function generateCorrelationId() {
  return `corr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}