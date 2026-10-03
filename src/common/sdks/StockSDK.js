import { Database } from '../database.mjs';
import { NotFoundError, InsufficientStockError, InvalidStateError, ValidationError } from '../errors.mjs';

/**
 * SDK Público - Interface uniforme para operações de estoque
 *
 * A quantidade disponível fica na tabela `inventory` (uma linha por produto,
 * id = productId), que pertence só a este serviço. Cada reserva debita o
 * estoque na mesma transação em que é registrada, então várias reservas do
 * mesmo produto podem coexistir sem risco de vender além do disponível, mesmo
 * com pedidos simultâneos.
 *
 * O inventário nasce do evento ProductCreated (initializeStock), publicado
 * pelo serviço de Products.
 */
export class StockSDK {
  constructor(eventBridgeClient, db = new Database()) {
    this.eventBridgeClient = eventBridgeClient;
    this.db = db;
  }

  /**
   * Criar o inventário de um produto recém-criado.
   * Idempotente: um evento ProductCreated repetido não altera o estoque.
   */
  async initializeStock({ productId, name, initialStock = 0 }) {
    const quantity = Number(initialStock);
    if (!productId) {
      throw new ValidationError('productId is required');
    }
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new ValidationError('initialStock must be a non-negative integer');
    }

    const now = new Date().toISOString();
    const item = { id: productId, name, stock: quantity, createdAt: now, updatedAt: now };
    const created = await this.db.putItemIfNotExists('inventory', item);
    return created ? item : this.db.getItem('inventory', { id: productId });
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
            table: 'inventory',
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
        const inventory = await this.db.getItem('inventory', { id: productId });
        if (!inventory) throw new NotFoundError('Inventory not found for product');
        throw new InsufficientStockError(
          `Insufficient stock: requested ${quantity}, available ${inventory.stock || 0}`
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
            table: 'inventory',
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
   * Ajustar estoque do produto (delta positivo ou negativo).
   * Um delta positivo cria o inventário se ele não existir (recupera um
   * ProductCreated perdido); `name` só é gravado se ainda não houver um.
   */
  async adjustStock(productId, delta, { name } = {}) {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new ValidationError('delta must be a non-zero integer');
    }

    const now = new Date().toISOString();
    const setName = name ? ', #name = if_not_exists(#name, :name)' : '';

    try {
      const attributes = await this.db.updateItem(
        'inventory',
        { id: productId },
        `SET stock = if_not_exists(stock, :zero) + :delta, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)${setName}`,
        {
          ':delta': delta,
          ':now': now,
          ':zero': 0,
          ':min': Math.max(0, -delta),
          ...(name && { ':name': name })
        },
        {
          conditionExpression: '(attribute_not_exists(stock) AND :min = :zero) OR stock >= :min',
          ...(name && { expressionAttributeNames: { '#name': 'name' } })
        }
      );
      return { productId, previousStock: attributes.stock - delta, stock: attributes.stock };
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;

      const inventory = await this.db.getItem('inventory', { id: productId });
      if (!inventory) throw new NotFoundError('Inventory not found for product');
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
    const inventory = await this.db.getItem('inventory', { id: productId });
    if (!inventory) {
      throw new NotFoundError('Inventory not found for product');
    }

    const activeReservations = (await this.db.scanItems('stockReservations'))
      .filter(r => r.productId === productId && r.status === 'active');

    return {
      productId: inventory.id,
      name: inventory.name,
      available: inventory.stock || 0,
      reserved: sumQuantities(activeReservations),
      activeReservations: activeReservations.length
    };
  }

  /**
   * Listar estoque
   */
  async listStock(filters = {}) {
    const allItems = await this.db.scanItems('inventory');
    const activeReservations = (await this.db.scanItems('stockReservations'))
      .filter(r => r.status === 'active');

    return allItems.filter(item => {
      if (filters.productId && item.id !== filters.productId) {
        return false;
      }
      if (filters.stockMin && item.stock < Number(filters.stockMin)) {
        return false;
      }
      if (filters.stockMax && item.stock > Number(filters.stockMax)) {
        return false;
      }
      return true;
    }).map(item => ({
      productId: item.id,
      name: item.name,
      available: item.stock || 0,
      reserved: sumQuantities(activeReservations.filter(r => r.productId === item.id))
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
