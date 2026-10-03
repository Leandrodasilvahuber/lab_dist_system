import { Database } from '../database.mjs';
import { NotFoundError, InsufficientStockError, InvalidStateError, ValidationError } from '../errors.mjs';

/**
 * SDK Público - Interface uniforme para operações de estoque
 *
 * O campo `stock` do produto é a quantidade disponível. Cada reserva debita o
 * estoque na mesma transação em que é registrada, então várias reservas do
 * mesmo produto podem coexistir sem risco de vender além do disponível, mesmo
 * com pedidos simultâneos.
 */
export class StockSDK {
  constructor(eventBridgeClient, db = new Database()) {
    this.eventBridgeClient = eventBridgeClient;
    this.db = db;
  }

  /**
   * Reservar estoque
   * `id` opcional torna a operação idempotente (a saga usa um id derivado do sagaId).
   */
  async reserveStock({ productId, quantity, correlationId, id }) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('Quantity must be a positive integer');
    }

    const now = new Date().toISOString();
    const reservation = {
      id: id || generateId(),
      productId,
      quantity,
      status: 'active',
      correlationId: correlationId || generateCorrelationId(),
      reservedAt: now
    };

    try {
      await this.db.transactWrite([
        {
          Put: {
            table: 'stockReservations',
            Item: reservation,
            ConditionExpression: 'attribute_not_exists(id)'
          }
        },
        {
          Update: {
            table: 'products',
            Key: { id: productId },
            UpdateExpression: 'SET stock = stock - :quantity, updatedAt = :now',
            ConditionExpression: 'attribute_exists(id) AND stock >= :quantity',
            ExpressionAttributeValues: { ':quantity': quantity, ':now': now }
          }
        }
      ]);
    } catch (error) {
      if (error.name !== 'TransactionCanceledException') throw error;
      throwIfConflict(error);

      const [reservationReason, productReason] = (error.CancellationReasons || []).map(r => r?.Code);

      // Reserva com este id já existe: repetição da mesma operação
      if (reservationReason === 'ConditionalCheckFailed') {
        return this.getReservation(reservation.id);
      }
      if (productReason === 'ConditionalCheckFailed') {
        const product = await this.db.getItem('products', { id: productId });
        if (!product) throw new NotFoundError('Product not found');
        throw new InsufficientStockError(
          `Insufficient stock: requested ${quantity}, available ${product.stock || 0}`
        );
      }
      throw error;
    }

    await this.publish('StockReserved', {
      reservationId: reservation.id,
      productId,
      quantity,
      correlationId: reservation.correlationId
    });

    return reservation;
  }

  /**
   * Liberar uma reserva e devolver a quantidade ao estoque.
   * Liberar uma reserva já liberada não é erro (idempotente).
   */
  async releaseStock({ reservationId, correlationId }) {
    const reservation = await this.getReservation(reservationId);

    if (reservation.status === 'released') {
      return reservation;
    }

    const now = new Date().toISOString();
    try {
      await this.db.transactWrite([
        {
          Update: {
            table: 'stockReservations',
            Key: { id: reservationId },
            UpdateExpression: 'SET #status = :released, releasedAt = :now',
            ConditionExpression: '#status = :active',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':released': 'released', ':active': 'active', ':now': now }
          }
        },
        {
          Update: {
            table: 'products',
            Key: { id: reservation.productId },
            UpdateExpression: 'SET stock = stock + :quantity, updatedAt = :now',
            ConditionExpression: 'attribute_exists(id)',
            ExpressionAttributeValues: { ':quantity': reservation.quantity, ':now': now }
          }
        }
      ]);
    } catch (error) {
      if (error.name !== 'TransactionCanceledException') throw error;
      throwIfConflict(error);

      // Outra execução liberou a reserva ao mesmo tempo
      const current = await this.getReservation(reservationId);
      if (current.status === 'released') return current;
      throw new InvalidStateError(`Cannot release reservation in status ${current.status}`);
    }

    const released = { ...reservation, status: 'released', releasedAt: now };

    await this.publish('StockReleased', {
      reservationId,
      productId: reservation.productId,
      quantity: reservation.quantity,
      correlationId: correlationId || reservation.correlationId
    });

    return released;
  }

  /**
   * Ajustar estoque do produto (delta positivo ou negativo)
   */
  async adjustStock(productId, delta) {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new ValidationError('delta must be a non-zero integer');
    }

    try {
      const attributes = await this.db.updateItem(
        'products',
        { id: productId },
        'SET stock = stock + :delta, updatedAt = :now',
        { ':delta': delta, ':now': new Date().toISOString(), ':min': Math.max(0, -delta) },
        { conditionExpression: 'attribute_exists(id) AND stock >= :min' }
      );
      return { productId, previousStock: attributes.stock - delta, stock: attributes.stock };
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;

      const product = await this.db.getItem('products', { id: productId });
      if (!product) throw new NotFoundError('Product not found');
      throw new InsufficientStockError('Insufficient stock for adjustment');
    }
  }

  async getReservation(reservationId) {
    const reservation = await this.db.getItem('stockReservations', { id: reservationId });
    if (!reservation) {
      throw new NotFoundError('Reservation not found');
    }
    return reservation;
  }

  /**
   * Buscar estoque por ID de produto
   */
  async getStock(productId) {
    const product = await this.db.getItem('products', { id: productId });
    if (!product) {
      throw new NotFoundError('Product not found');
    }

    const activeReservations = (await this.db.scanItems('stockReservations'))
      .filter(r => r.productId === productId && r.status === 'active');

    return {
      productId: product.id,
      available: product.stock || 0,
      reserved: sumQuantities(activeReservations),
      activeReservations: activeReservations.length
    };
  }

  /**
   * Listar estoque
   */
  async listStock(filters = {}) {
    const allProducts = await this.db.scanItems('products');
    const activeReservations = (await this.db.scanItems('stockReservations'))
      .filter(r => r.status === 'active');

    return allProducts.filter(product => {
      if (filters.productId && product.id !== filters.productId) {
        return false;
      }
      if (filters.stockMin && product.stock < Number(filters.stockMin)) {
        return false;
      }
      if (filters.stockMax && product.stock > Number(filters.stockMax)) {
        return false;
      }
      return true;
    }).map(product => ({
      productId: product.id,
      name: product.name,
      available: product.stock || 0,
      reserved: sumQuantities(activeReservations.filter(r => r.productId === product.id))
    }));
  }

  async publish(detailType, detail) {
    if (this.eventBridgeClient) {
      await this.eventBridgeClient.publish({ Source: 'stock', DetailType: detailType, Detail: detail });
    }
  }
}

/**
 * Transações concorrentes no mesmo item são canceladas com TransactionConflict.
 * É uma falha transitória: relança com um nome que o Step Functions repete.
 */
function throwIfConflict(error) {
  if ((error.CancellationReasons || []).some(r => r?.Code === 'TransactionConflict')) {
    const conflict = new Error('Concurrent update on the same item, retry');
    conflict.name = 'TransactionConflictException';
    throw conflict;
  }
}

function sumQuantities(reservations) {
  return reservations.reduce((sum, r) => sum + r.quantity, 0);
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

export default StockSDK;
