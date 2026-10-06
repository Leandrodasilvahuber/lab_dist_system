import { Database } from '../database.mjs';
import { NotFoundError, InvalidStateError, ValidationError } from '../errors.mjs';
import { generateId } from '../ids.mjs';
import { requireId, roundMoney } from '../validation.mjs';
import { encodeToken } from '../pagination.mjs';

// Leitura logo depois de uma escrita (retry de um passo, passo seguinte da
// saga): a leitura eventualmente consistente poderia não ver o item gravado
const CONSISTENT = { consistentRead: true };

/**
 * SDK Público - Interface uniforme para operações de pedido
 *
 * Status: pending -> confirmed | cancelled (confirmed também pode ser cancelado)
 * `voided` marca um pedido que a saga anulou antes de ele ser gravado
 * (compensação de um CreateOrder que falhou sem resposta).
 */
export class OrderSDK {
  constructor(eventBridgeClient, db = new Database()) {
    this.eventBridgeClient = eventBridgeClient;
    this.db = db;
  }

  /**
   * Criar pedido
   * `id` opcional torna a operação idempotente (a saga usa um id derivado do sagaId).
   * `unitPrice` vem da saga, que consultou o serviço de Products ao iniciar.
   */
  async createOrder({ productId, quantity, unitPrice, correlationId, id }) {
    if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('productId and a positive integer quantity are required');
    }
    if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new ValidationError('unitPrice must be a non-negative number');
    }

    const now = new Date().toISOString();
    const order = {
      id: id || generateId('order'),
      productId,
      quantity,
      unitPrice,
      total: roundMoney(unitPrice * quantity),
      status: 'pending',
      correlationId: correlationId || generateId('corr'),
      createdAt: now,
      updatedAt: now
    };

    const created = await this.db.putItemIfNotExists('orders', order);
    if (!created) {
      // Leitura direta: getOrder esconde os registros `voided`
      const existing = await this.db.getItem('orders', { id: order.id }, CONSISTENT);
      if (!existing || existing.status === 'voided') {
        throw new InvalidStateError('Order was voided by the saga compensation');
      }
      return existing;
    }

    await this.publish('OrderCreated', {
      orderId: order.id,
      productId,
      quantity,
      total: order.total,
      correlationId: order.correlationId
    });

    return order;
  }

  /**
   * Buscar pedido por ID. Um registro `voided` não é um pedido de fato
   * (só barra um CreateOrder atrasado), então responde como inexistente.
   * `options.consistentRead`: usado pela saga, que lê logo depois de gravar.
   */
  async getOrder(orderId, options) {
    requireId(orderId, 'orderId');
    const order = await this.db.getItem('orders', { id: orderId }, options);
    if (!order || order.status === 'voided') {
      throw new NotFoundError('Order not found');
    }
    return order;
  }

  /**
   * Confirmar pedido (pending -> confirmed). Confirmar de novo não é erro.
   */
  async confirmOrder(orderId, correlationId) {
    const order = await this.transition(orderId, ['pending'], 'confirmed');
    if (order.changed) {
      await this.publish('OrderConfirmed', { orderId, correlationId: correlationId || order.correlationId });
    }
    return order.item;
  }

  /**
   * Cancelar pedido (pending/confirmed -> cancelled). Cancelar de novo não é erro.
   * Usado como compensação da saga, inclusive quando o próprio CreateOrder
   * falhou: se o pedido nunca foi gravado, grava um registro `voided`, para
   * que um CreateOrder atrasado com o mesmo id não crie o pedido depois.
   */
  async cancelOrder(orderId, correlationId) {
    const existing = await this.db.getItem('orders', { id: orderId }, CONSISTENT);
    if (!existing) {
      const voided = { id: orderId, status: 'voided', voidedAt: new Date().toISOString(), correlationId };
      if (await this.db.putItemIfNotExists('orders', voided)) {
        return voided;
      }
      // O pedido foi gravado entre a leitura e a anulação: cancela normalmente
      return this.cancelOrder(orderId, correlationId);
    }
    if (existing.status === 'voided') {
      return existing;
    }

    const order = await this.transition(orderId, ['pending', 'confirmed'], 'cancelled');
    if (order.changed) {
      await this.publish('OrderCancelled', { orderId, correlationId: correlationId || order.correlationId });
    }
    return order.item;
  }

  /**
   * Muda o status de forma atômica (condicional ao status atual)
   */
  async transition(orderId, allowedFrom, to) {
    const order = await this.getOrder(orderId, CONSISTENT);
    if (order.status === to) {
      return { item: order, changed: false };
    }

    const values = { ':to': to, ':now': new Date().toISOString() };
    allowedFrom.forEach((status, i) => { values[`:from${i}`] = status; });

    try {
      const item = await this.db.updateItem(
        'orders',
        { id: orderId },
        'SET #status = :to, updatedAt = :now',
        values,
        {
          conditionExpression: `#status IN (${allowedFrom.map((_, i) => `:from${i}`).join(', ')})`,
          expressionAttributeNames: { '#status': 'status' },
          returnValues: 'ALL_NEW'
        }
      );
      return { item, changed: true };
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;

      const current = await this.getOrder(orderId, CONSISTENT);
      if (current.status === to) return { item: current, changed: false };
      throw new InvalidStateError(`Cannot change order from ${current.status} to ${to}`);
    }
  }

  /**
   * Listar pedidos, uma página por vez (`limit`, `startKey`), sem os registros
   * `voided`, que não são pedidos de fato. Como em listProducts, os filtros
   * valem para a página lida, que pode vir com menos de `limit` itens.
   * @param {Record<string, any>} [filters]
   * @param {object} [page]
   * @param {number} [page.limit]
   * @param {Record<string, any>} [page.startKey] LastEvaluatedKey da página anterior
   */
  async listOrders(filters = {}, { limit, startKey } = {}) {
    const { items, lastKey } = await this.db.scanPage('orders', { limit, startKey });
    const orders = items.filter(order => {
      if (order.status === 'voided') {
        return false;
      }
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
    return { orders, nextToken: encodeToken(lastKey) };
  }

  async publish(detailType, detail) {
    if (this.eventBridgeClient) {
      await this.eventBridgeClient.publish({ Source: 'orders', DetailType: detailType, Detail: detail });
    }
  }
}

export default OrderSDK;
