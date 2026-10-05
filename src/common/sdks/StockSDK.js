import { Database } from '../database.mjs';
import { NotFoundError, InsufficientStockError, InvalidStateError, ValidationError } from '../errors.mjs';
import { generateId } from '../ids.mjs';
import { encodeToken } from '../pagination.mjs';
import { optionalNumber, requireId, toNumber } from '../validation.mjs';
import { log } from '../logger.mjs';
import { isTransientAwsError } from '../aws-client.mjs';

// GSI esparso da tabela de reservas, chave `activeProductId`: o atributo só
// existe enquanto a reserva está ativa (é removido no commit e na liberação).
// O índice guarda só as compras em andamento, particionadas por produto, sem
// concentrar escritas numa partição de status com poucos valores.
const ACTIVE_INDEX = 'ActiveReservationsIndex';

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

// Leitura logo depois de uma escrita (retry de um passo, passo seguinte da
// saga): a leitura eventualmente consistente poderia não ver o item gravado
const CONSISTENT = { consistentRead: true };
export class StockSDK {
  /**
   * `productClient` (ProductClient): confere no serviço de Products que o
   * produto existe antes de um ajuste criar o inventário. Sem ele (testes,
   * scripts), o ajuste não confere.
   */
  constructor(eventBridgeClient, db = new Database(), { productClient } = {}) {
    this.eventBridgeClient = eventBridgeClient;
    this.db = db;
    this.productClient = productClient;
  }

  /**
   * Criar o inventário de um produto recém-criado.
   * Idempotente: um evento ProductCreated repetido não altera o estoque.
   * Se o inventário já tinha sido criado por um ajuste (adjustStock recuperando
   * um ProductCreated perdido), o estoque inicial do evento é descartado: fica
   * um aviso no log para quem ajustou conferir a quantidade.
   */
  async initializeStock({ productId, name, initialStock = 0, correlationId }) {
    const quantity = toNumber(initialStock);
    if (!productId) {
      throw new ValidationError('productId is required');
    }
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new ValidationError('initialStock must be a non-negative integer');
    }

    const now = new Date().toISOString();
    // initialStock gravado identifica o inventário criado por este evento
    const item = { id: productId, name, stock: quantity, initialStock: quantity, createdAt: now, updatedAt: now };
    if (await this.db.putItemIfNotExists('inventory', item)) {
      return item;
    }

    const existing = await this.db.getItem('inventory', { id: productId }, CONSISTENT);
    if (isLive(existing) && existing.initialStock === undefined) {
      log({
        event: 'STOCK_INITIAL_IGNORED',
        correlationId,
        status: 'warn',
        message: `Inventory of ${productId} was created by a stock adjustment; initialStock ${quantity} from ProductCreated was ignored`,
        data: { productId, initialStock: quantity, stock: existing.stock }
      });
    }
    return existing;
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
      activeProductId: productId,
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
        const inventory = await this.db.getItem('inventory', { id: productId }, CONSISTENT);
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
        'SET #status = :committed, committedAt = :now REMOVE activeProductId',
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
    const reservation = await this.db.getItem('stockReservations', { id: reservationId }, CONSISTENT);

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
            UpdateExpression: 'SET #status = :released, releasedAt = :now REMOVE activeProductId',
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
    delete released.activeProductId;

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
        'SET #status = :released, releasedAt = :now, inventoryMissing = :true REMOVE activeProductId',
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
   * ProductCreated perdido), desde que o produto exista no catálogo: sem a
   * conferência, um id digitado errado criaria estoque de um produto que não
   * existe. `name` só é gravado se ainda não houver um (sem ele, vale o do
   * catálogo).
   */
  async adjustStock(productId, delta, { name } = {}) {
    requireId(productId, 'productId');
    if (!Number.isInteger(delta) || delta === 0) {
      throw new ValidationError('delta must be a non-zero integer');
    }

    // Com o catálogo, o ajuste positivo grava primeiro só em inventário
    // existente (o caso comum: uma escrita, sem leitura); o produto só é
    // conferido quando o ajuste criaria o inventário
    const checkCatalog = delta > 0 && Boolean(this.productClient);
    try {
      return await this.writeAdjustment(productId, delta, name, { mustExist: checkCatalog });
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }

    const inventory = await this.db.getItem('inventory', { id: productId }, CONSISTENT);
    if (!checkCatalog || inventory) throw adjustmentError(inventory);

    // NotFound do Products vira 404; Products fora do ar, 503
    const product = await this.productClient.getProduct(productId);
    try {
      return await this.writeAdjustment(productId, delta, name || product.name, { mustExist: false });
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      // Removido (ProductDeleted) entre a leitura e a escrita
      throw adjustmentError(await this.db.getItem('inventory', { id: productId }, CONSISTENT));
    }
  }

  /**
   * Soma o delta. `mustExist`: só altera inventário existente; sem ele, um
   * delta positivo cria o inventário. Lança ConditionalCheckFailedException se
   * o inventário foi removido, não existe (com `mustExist`) ou ficaria negativo.
   */
  async writeAdjustment(productId, delta, name, { mustExist }) {
    const setName = name ? ', #name = if_not_exists(#name, :name)' : '';
    const condition = 'attribute_not_exists(deleted) AND ((attribute_not_exists(stock) AND :min = :zero) OR stock >= :min)';
    const attributes = await this.db.updateItem(
      'inventory',
      { id: productId },
      `SET stock = if_not_exists(stock, :zero) + :delta, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)${setName}`,
      {
        ':delta': delta,
        ':now': new Date().toISOString(),
        ':zero': 0,
        ':min': Math.max(0, -delta),
        ...(name && { ':name': name })
      },
      {
        conditionExpression: mustExist ? `attribute_exists(id) AND ${condition}` : condition,
        ...(name && { expressionAttributeNames: { '#name': 'name' } }),
        // Soma o delta: um retry do SDK depois de timeout somaria duas vezes
        retry: false
      }
    );
    return { productId, previousStock: attributes.stock - delta, stock: attributes.stock };
  }

  // Só a saga consulta reservas, sempre logo depois de gravar
  async getReservation(reservationId) {
    const reservation = await this.db.getItem('stockReservations', { id: reservationId }, CONSISTENT);
    if (!reservation) {
      throw new NotFoundError('Reservation not found');
    }
    return reservation;
  }

  /**
   * Buscar estoque por ID de produto
   */
  async getStock(productId) {
    requireId(productId, 'productId');
    const inventory = await this.db.getItem('inventory', { id: productId });
    if (!isLive(inventory)) {
      throw new NotFoundError('Inventory not found for product');
    }

    const reservations = await this.reservationsSummary(productId);
    if (reservations.error) logReservationsUnavailable([productId], reservations.error);

    return {
      productId: inventory.id,
      name: inventory.name,
      available: inventory.stock || 0,
      reserved: reservations.reserved ?? null,
      activeReservations: reservations.count ?? null,
      ...(reservations.error && { degraded: true })
    };
  }

  /**
   * Listar estoque, uma página por vez (`limit`, `startKey`).
   * Como em listProducts, os filtros valem para a página lida (exceto
   * `productId`, que lê o item direto e devolve uma única página).
   * As reservas ativas são consultadas só para os produtos da página (uma
   * Query por produto no índice esparso): o custo acompanha o tamanho da
   * página, não o total de compras em andamento.
   */
  async listStock(filters = {}, { limit, startKey } = {}) {
    const stockMin = optionalNumber(filters.stockMin, 'stockMin');
    const stockMax = optionalNumber(filters.stockMax, 'stockMax');
    if (filters.productId) requireId(filters.productId, 'productId');

    // Com productId, lê direto pela chave: um scan paginado poderia devolver
    // várias páginas vazias antes de chegar ao produto
    const { items, lastKey } = filters.productId
      ? { items: [await this.db.getItem('inventory', { id: filters.productId })].filter(Boolean) }
      : await this.db.scanPage('inventory', { limit, startKey });

    const selected = items.filter(item => {
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
    });

    const summaries = await Promise.all(selected.map(item => this.reservationsSummary(item.id)));
    const stock = selected.map((item, i) => ({
      productId: item.id,
      name: item.name,
      available: item.stock || 0,
      reserved: summaries[i].reserved ?? null
    }));
    // Um registro só para a página: com o índice fora do ar, todas as
    // consultas falham juntas e uma linha por produto inflaria a métrica
    const failed = summaries.flatMap((summary, i) => summary.error ? [selected[i].id] : []);
    if (failed.length) logReservationsUnavailable(failed, summaries.find(summary => summary.error).error);
    return { stock, nextToken: encodeToken(lastKey), ...(failed.length && { degraded: true }) };
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
    // UpdateItem, não PutItem: mantém nome e createdAt do inventário removido
    // (ou cria o registro, se o ProductCreated ainda não chegou)
    await this.db.updateItem(
      'inventory',
      { id: productId },
      'SET deleted = :true, stock = :zero, deletedAt = if_not_exists(deletedAt, :now), updatedAt = :now',
      { ':true': true, ':zero': 0, ':now': now }
    );
    return { productId, removed: true };
  }

  /**
   * Total reservado em compras em andamento, só para exibição. Degradação
   * graciosa: se a consulta ao índice falhar, devolve `{ error }` em vez de
   * derrubar a leitura inteira (quem chama registra a falha). O `available`
   * (o que vale para comprar) segue exato, porque vem do inventário.
   */
  async reservationsSummary(productId) {
    try {
      const reservations = await this.activeReservations(productId);
      return { reserved: sumQuantities(reservations), count: reservations.length };
    } catch (error) {
      // Só falha de infraestrutura degrada; bug de código e configuração
      // errada (índice ou tabela inexistente) continuam sendo 500
      if (!isDependencyFailure(error)) throw error;
      return { error };
    }
  }

  /**
   * Reservas ativas (compras em andamento) de um produto, pelo índice
   * esparso, que só contém as reservas ativas. Uma tentativa só: é leitura
   * para exibição, que degrada se falhar (reservationsSummary).
   */
  async activeReservations(productId) {
    return this.db.queryItems('stockReservations', {
      IndexName: ACTIVE_INDEX,
      KeyConditionExpression: 'activeProductId = :productId',
      ExpressionAttributeValues: { ':productId': productId }
    }, { retry: false });
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

// Ajuste recusado pela condição: inventário inexistente/removido ou estoque insuficiente
function adjustmentError(inventory) {
  return isLive(inventory)
    ? new InsufficientStockError('Insufficient stock for adjustment')
    : new NotFoundError('Inventory not found for product');
}

/**
 * Falha de infraestrutura (o índice de reservas não respondeu): error, como
 * as outras falhas de dependência, mesmo que a resposta saia degradada.
 */
function logReservationsUnavailable(productIds, error) {
  log({
    event: 'STOCK_RESERVATIONS_UNAVAILABLE',
    status: 'error',
    message: `Active reservations unavailable for ${productIds.length} product(s), responding without them`,
    data: { productIds },
    error
  });
}

// Erros do DynamoDB que indicam configuração errada, não queda: não degradam
const CONFIGURATION_ERRORS = new Set(['ResourceNotFoundException', 'ValidationException', 'AccessDeniedException']);

// Falha da dependência (resposta de erro do serviço ou rede/timeout), exceto
// configuração errada
function isDependencyFailure(error) {
  if (CONFIGURATION_ERRORS.has(error?.name)) return false;
  return Boolean(error?.$metadata) || isTransientAwsError(error);
}

function sumQuantities(reservations) {
  return reservations.reduce((sum, r) => sum + r.quantity, 0);
}

export default StockSDK;
