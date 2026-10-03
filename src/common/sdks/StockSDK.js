import { Database } from '../database.mjs';
import { NotFoundError, InsufficientStockError, InvalidStateError, ValidationError } from '../errors.mjs';
import { generateId } from '../ids.mjs';
import { encodeToken } from '../pagination.mjs';
import { optionalNumber } from '../validation.mjs';

// GSI da tabela de reservas (status, productId): consulta as reservas ativas
// sem varrer a tabela. Depois do commit, só as compras em andamento ficam ativas.
const STATUS_INDEX = 'StatusIndex';

/**
 * SDK Público - Interface uniforme para operações de estoque
 *
 * A quantidade disponível fica na tabela `inventory` (uma linha por produto,
 * id = productId), que pertence só a este serviço. Cada reserva debita o
 * estoque na mesma transação em que é registrada, então várias reservas do
 * mesmo produto podem coexistir sem risco de vender além do disponível, mesmo
 * com pedidos simultâneos.
 *
 * Status da reserva: active -> committed (compra concluída) | released (compensada)
 *
 * O inventário nasce do evento ProductCreated (initializeStock), publicado
 * pelo serviço de Products, e é removido com ProductDeleted (removeInventory).
 * A remoção deixa um registro `deleted`: o EventBridge não garante a ordem
 * de entrega, e um ProductCreated que chegue depois não recria o inventário.
 */

// Inventário existente e não removido (ver removeInventory)
const INVENTORY_LIVE = 'attribute_exists(id) AND attribute_not_exists(deleted)';
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
    if (!productId) {
      throw new ValidationError('productId is required');
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('Quantity must be a positive integer');
    }

    const now = new Date().toISOString();
    const reservation = {
      id: id || generateId('res'),
      productId,
      quantity,
      status: 'active',
      correlationId: correlationId || generateId('corr'),
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
            ConditionExpression: `${INVENTORY_LIVE} AND stock >= :quantity`,
            ExpressionAttributeValues: { ':quantity': quantity, ':now': now }
          }
        }
      ]);
    } catch (error) {
      if (error.name !== 'TransactionCanceledException') throw error;
      throwIfConflict(error);

      const [reservationReason, productReason] = (error.CancellationReasons || []).map(r => r?.Code);

      // Reserva com este id já existe: repetição da mesma operação, ou a saga
      // já compensou (liberou) esta reserva e ela não pode mais ser usada
      if (reservationReason === 'ConditionalCheckFailed') {
        const existing = await this.getReservation(reservation.id);
        if (existing.status === 'released') {
          throw new InvalidStateError('Reservation was already released by the saga compensation');
        }
        return existing;
      }
      if (productReason === 'ConditionalCheckFailed') {
        const inventory = await this.db.getItem('inventory', { id: productId });
        if (!isLive(inventory)) throw new NotFoundError('Inventory not found for product');
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
   * Confirmar a reserva de uma compra concluída (active -> committed).
   * O estoque já foi debitado na reserva; aqui ela só deixa de contar como
   * "reservada". Confirmar de novo não é erro.
   */
  async commitReservation({ reservationId, correlationId }) {
    const reservation = await this.getReservation(reservationId);
    if (reservation.status === 'committed') {
      return reservation;
    }

    try {
      const committed = await this.db.updateItem(
        'stockReservations',
        { id: reservationId },
        'SET #status = :committed, committedAt = :now',
        { ':committed': 'committed', ':active': 'active', ':now': new Date().toISOString() },
        {
          conditionExpression: '#status = :active',
          expressionAttributeNames: { '#status': 'status' },
          returnValues: 'ALL_NEW'
        }
      );

      await this.publish('StockCommitted', {
        reservationId,
        productId: reservation.productId,
        quantity: reservation.quantity,
        correlationId: correlationId || reservation.correlationId
      });

      return committed;
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;

      const current = await this.getReservation(reservationId);
      if (current.status === 'committed') return current;
      throw new InvalidStateError(`Cannot commit reservation in status ${current.status}`);
    }
  }

  /**
   * Liberar uma reserva (ativa ou confirmada) e devolver a quantidade ao estoque.
   * Idempotente: liberar de novo não é erro. Se a reserva não existe (o
   * ReserveStock falhou antes de gravar), grava um registro `released` para que
   * uma reserva atrasada com o mesmo id não debite o estoque depois.
   * Se o produto foi excluído durante a compra, a reserva é liberada sem
   * devolver estoque (não há mais inventário para onde devolver).
   */
  async releaseStock({ reservationId, correlationId }) {
    const reservation = await this.db.getItem('stockReservations', { id: reservationId });

    if (!reservation) {
      const tombstone = { id: reservationId, status: 'released', releasedAt: new Date().toISOString(), quantity: 0, correlationId };
      if (await this.db.putItemIfNotExists('stockReservations', tombstone)) {
        return tombstone;
      }
      // A reserva foi gravada entre a leitura e a liberação: libera normalmente
      return this.releaseStock({ reservationId, correlationId });
    }

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
            ConditionExpression: '#status IN (:active, :committed)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':released': 'released', ':active': 'active', ':committed': 'committed', ':now': now }
          }
        },
        {
          Update: {
            table: 'inventory',
            Key: { id: reservation.productId },
            UpdateExpression: 'SET stock = stock + :quantity, updatedAt = :now',
            ConditionExpression: INVENTORY_LIVE,
            ExpressionAttributeValues: { ':quantity': reservation.quantity, ':now': now }
          }
        }
      ]);
    } catch (error) {
      if (error.name !== 'TransactionCanceledException') throw error;
      throwIfConflict(error);

      const [reservationReason, inventoryReason] = (error.CancellationReasons || []).map(r => r?.Code);
      if (reservationReason !== 'ConditionalCheckFailed' && inventoryReason === 'ConditionalCheckFailed') {
        return this.releaseWithoutInventory(reservation, correlationId, now);
      }

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
   * Libera a reserva de um produto que foi excluído (inventário removido).
   */
  async releaseWithoutInventory(reservation, correlationId, now) {
    try {
      const released = await this.db.updateItem(
        'stockReservations',
        { id: reservation.id },
        'SET #status = :released, releasedAt = :now, inventoryMissing = :true',
        { ':released': 'released', ':active': 'active', ':committed': 'committed', ':now': now, ':true': true },
        {
          conditionExpression: '#status IN (:active, :committed)',
          expressionAttributeNames: { '#status': 'status' },
          returnValues: 'ALL_NEW'
        }
      );
      await this.publish('StockReleased', {
        reservationId: reservation.id,
        productId: reservation.productId,
        quantity: reservation.quantity,
        inventoryMissing: true,
        correlationId: correlationId || reservation.correlationId
      });
      return released;
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      const current = await this.getReservation(reservation.id);
      if (current.status === 'released') return current;
      throw new InvalidStateError(`Cannot release reservation in status ${current.status}`);
    }
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
          conditionExpression: 'attribute_not_exists(deleted) AND ((attribute_not_exists(stock) AND :min = :zero) OR stock >= :min)',
          ...(name && { expressionAttributeNames: { '#name': 'name' } })
        }
      );
      return { productId, previousStock: attributes.stock - delta, stock: attributes.stock };
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;

      const inventory = await this.db.getItem('inventory', { id: productId });
      if (!isLive(inventory)) throw new NotFoundError('Inventory not found for product');
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
    if (!isLive(inventory)) {
      throw new NotFoundError('Inventory not found for product');
    }

    const activeReservations = await this.activeReservations(productId);

    return {
      productId: inventory.id,
      name: inventory.name,
      available: inventory.stock || 0,
      reserved: sumQuantities(activeReservations),
      activeReservations: activeReservations.length
    };
  }

  /**
   * Listar estoque, uma página por vez (`limit`, `startKey`).
   * Como em listProducts, os filtros valem para a página lida (exceto
   * `productId`, que lê o item direto e devolve uma única página).
   */
  async listStock(filters = {}, { limit, startKey } = {}) {
    const stockMin = optionalNumber(filters.stockMin, 'stockMin');
    const stockMax = optionalNumber(filters.stockMax, 'stockMax');

    // Com productId, lê direto pela chave: um scan paginado poderia devolver
    // várias páginas vazias antes de chegar ao produto
    const { items, lastKey } = filters.productId
      ? { items: [await this.db.getItem('inventory', { id: filters.productId })].filter(Boolean) }
      : await this.db.scanPage('inventory', { limit, startKey });
    const activeReservations = await this.activeReservations(filters.productId);

    const stock = items.filter(item => {
      if (!isLive(item)) {
        return false;
      }
      if (filters.productId && item.id !== filters.productId) {
        return false;
      }
      if (stockMin !== undefined && item.stock < stockMin) {
        return false;
      }
      if (stockMax !== undefined && item.stock > stockMax) {
        return false;
      }
      return true;
    }).map(item => ({
      productId: item.id,
      name: item.name,
      available: item.stock || 0,
      reserved: sumQuantities(activeReservations.filter(r => r.productId === item.id))
    }));
    return { stock, nextToken: encodeToken(lastKey) };
  }

  /**
   * Remover o inventário de um produto excluído (evento ProductDeleted).
   * Grava um registro `deleted` em vez de apagar a linha, para que um
   * ProductCreated entregue depois (fora de ordem) não recrie o inventário.
   * Idempotente: remover de novo não é erro.
   */
  async removeInventory({ productId }) {
    if (!productId) {
      throw new ValidationError('productId is required');
    }
    const now = new Date().toISOString();
    await this.db.putItem('inventory', { id: productId, deleted: true, stock: 0, deletedAt: now, updatedAt: now });
    return { productId, removed: true };
  }

  /**
   * Reservas ativas (compras em andamento), de um produto ou de todos,
   * consultadas pelo GSI de status.
   */
  async activeReservations(productId) {
    return this.db.queryItems('stockReservations', {
      IndexName: STATUS_INDEX,
      KeyConditionExpression: productId ? '#status = :active AND productId = :productId' : '#status = :active',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ...(productId && { ':productId': productId }) }
    });
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

function isLive(inventory) {
  return Boolean(inventory) && !inventory.deleted;
}

function sumQuantities(reservations) {
  return reservations.reduce((sum, r) => sum + r.quantity, 0);
}

export default StockSDK;
