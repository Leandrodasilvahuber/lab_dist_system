import { Database } from '../database.mjs';
import { NotFoundError, ValidationError } from '../errors.mjs';
import { generateId } from '../ids.mjs';
import { encodeToken } from '../pagination.mjs';
import { optionalNumber } from '../validation.mjs';
import { log } from '../logger.mjs';

/**
 * SDK Público - Interface uniforme para operações de produto
 *
 * A tabela `products` guarda só o catálogo (nome, preço, descrição). A
 * quantidade em estoque pertence ao serviço de Stock: o estoque inicial segue
 * no evento ProductCreated e o Stock cria o inventário a partir dele.
 * Ao excluir um produto, o evento ProductDeleted faz o Stock remover o inventário.
 */
export class ProductSDK {
  constructor(eventBridgeClient, db = new Database()) {
    this.eventBridgeClient = eventBridgeClient;
    this.db = db;
  }

  /**
   * Criar produto
   * O evento ProductCreated é obrigatório: sem ele o Stock nunca cria o
   * inventário. Se a publicação falhar, o produto é removido e o erro relançado.
   * Uma falha ambígua (ex.: timeout) pode ter entregue o evento mesmo assim,
   * então também é publicado ProductDeleted, para o Stock não manter um
   * inventário órfão.
   */
  async createProduct({ initialStock = 0, ...productData }) {
    const now = new Date().toISOString();
    const product = {
      ...productData,
      id: generateId('prod'),
      createdAt: now,
      updatedAt: now
    };

    await this.db.putItem('products', product);

    try {
      await this.publish('ProductCreated', {
        productId: product.id,
        name: product.name,
        initialStock,
        correlationId: generateId('corr')
      }, { required: true });
    } catch (error) {
      // O erro original é o que importa para quem chamou; falhas do rollback só vão para o log
      try {
        await this.db.deleteItem('products', { id: product.id });
      } catch (rollbackError) {
        log({ event: 'PRODUCT_ROLLBACK_FAILED', status: 'error', message: `Failed to delete product ${product.id}`, error: rollbackError });
      } finally {
        await this.publish('ProductDeleted', { productId: product.id, correlationId: generateId('corr') })
          .catch(publishError => log({ event: 'PRODUCT_ROLLBACK_FAILED', status: 'error', message: `Failed to publish ProductDeleted for ${product.id}`, error: publishError }));
      }
      throw error;
    }

    return product;
  }

  /**
   * Buscar produto por ID
   */
  async getProduct(productId) {
    const product = await this.db.getItem('products', { id: productId });
    if (!product) {
      throw new NotFoundError('Product not found');
    }
    return product;
  }

  /**
   * Listar produtos, uma página por vez (`limit`, `startKey`).
   * Os filtros são aplicados à página lida, que pode vir com menos de `limit`
   * itens; a listagem termina quando `nextToken` não vem.
   */
  async listProducts(filters = {}, { limit, startKey } = {}) {
    const priceMin = optionalNumber(filters.priceMin, 'priceMin');
    const priceMax = optionalNumber(filters.priceMax, 'priceMax');

    const { items, lastKey } = await this.db.scanPage('products', { limit, startKey });
    const products = items.filter(product => {
      if (filters.name && !(product.name || '').toLowerCase().includes(String(filters.name).toLowerCase())) {
        return false;
      }
      if (priceMin !== undefined && product.price < priceMin) {
        return false;
      }
      if (priceMax !== undefined && product.price > priceMax) {
        return false;
      }
      return true;
    });
    return { products, nextToken: encodeToken(lastKey) };
  }

  /**
   * Atualizar produto
   * Altera só os campos enviados (UpdateItem), sem regravar o item inteiro.
   */
  async updateProduct(productId, updates) {
    if ('stock' in updates) {
      throw new ValidationError('stock is managed by the stock service');
    }
    if ('price' in updates && (typeof updates.price !== 'number' || !Number.isFinite(updates.price) || updates.price < 0)) {
      throw new ValidationError('price must be a non-negative number');
    }

    const fields = Object.entries(updates)
      .filter(([key, value]) => !['id', 'createdAt', 'updatedAt'].includes(key) && value !== undefined);
    const names = {};
    const values = { ':updatedAt': new Date().toISOString() };
    const sets = ['updatedAt = :updatedAt'];
    fields.forEach(([key, value], i) => {
      names[`#f${i}`] = key;
      values[`:f${i}`] = value;
      sets.push(`#f${i} = :f${i}`);
    });

    try {
      return await this.db.updateItem('products', { id: productId }, `SET ${sets.join(', ')}`, values, {
        conditionExpression: 'attribute_exists(id)',
        returnValues: 'ALL_NEW',
        ...(fields.length && { expressionAttributeNames: names })
      });
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') throw new NotFoundError('Product not found');
      throw error;
    }
  }

  /**
   * Deletar produto
   * Publica ProductDeleted para o Stock remover o inventário do produto.
   */
  async deleteProduct(productId) {
    try {
      await this.db.deleteItem('products', { id: productId }, { conditionExpression: 'attribute_exists(id)' });
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') throw new NotFoundError('Product not found');
      throw error;
    }

    await this.publish('ProductDeleted', { productId, correlationId: generateId('corr') });
    return { success: true };
  }

  async publish(detailType, detail, options) {
    if (this.eventBridgeClient) {
      await this.eventBridgeClient.publish({ Source: 'products', DetailType: detailType, Detail: detail }, options);
    }
  }
}

export default ProductSDK;
