import { Database } from '../database.mjs';
import { NotFoundError, ValidationError } from '../errors.mjs';
import { generateId } from '../ids.mjs';
import { encodeToken } from '../pagination.mjs';
import { optionalNumber, requireId, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH } from '../validation.mjs';
import { log } from '../logger.mjs';

// Campos que updateProduct aceita (id, datas e estoque não são do cliente)
const UPDATABLE_FIELDS = ['name', 'price', 'description'];

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
    requireId(productId, 'productId');
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
   * Atualizar produto. API interna: não há rota HTTP (o HttpApi expõe
   * GET /products, GET /products/{id}, POST /products e DELETE /products/{id});
   * quem expuser precisa protegê-la como admin (ADMIN_ROUTES em auth.mjs e
   * Auth no template.yaml).
   * Altera só os campos enviados (UpdateItem), sem regravar o item inteiro.
   * Só aceita os campos do catálogo (UPDATABLE_FIELDS), com as mesmas regras
   * da criação; qualquer outro campo é recusado em vez de gravado às cegas.
   */
  async updateProduct(productId, updates) {
    // Campo com valor undefined conta como não enviado
    const changes = Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined));
    if ('stock' in changes) {
      throw new ValidationError('stock is managed by the stock service');
    }
    const unknown = Object.keys(changes).filter(key => !UPDATABLE_FIELDS.includes(key));
    if (unknown.length) {
      throw new ValidationError(`Fields cannot be updated: ${unknown.join(', ')}`);
    }
    if ('price' in changes && (typeof changes.price !== 'number' || !Number.isFinite(changes.price) || changes.price <= 0)) {
      throw new ValidationError('price must be a positive number');
    }
    if ('name' in changes) {
      if (typeof changes.name !== 'string' || !changes.name.trim() || changes.name.trim().length > MAX_NAME_LENGTH) {
        throw new ValidationError(`name must be a non-empty string with at most ${MAX_NAME_LENGTH} characters`);
      }
      changes.name = changes.name.trim();
    }
    if ('description' in changes && (typeof changes.description !== 'string' || changes.description.length > MAX_DESCRIPTION_LENGTH)) {
      throw new ValidationError(`description must be a string with at most ${MAX_DESCRIPTION_LENGTH} characters`);
    }

    const fields = Object.entries(changes);
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
   * Deletar produto (DELETE /products/{id}, rota de admin). O evento
   * ProductDeleted é obrigatório, como o ProductCreated: sem ele o Stock
   * manteria o inventário de um produto que não existe mais. Se a publicação
   * falhar, o produto volta ao catálogo e o erro é relançado;
   * chamar de novo exclui e publica outra vez (a remoção do inventário é
   * idempotente). Uma falha ambígua (timeout) pode ter entregue o evento: o
   * produto volta sem estoque e a nova chamada termina a exclusão.
   */
  async deleteProduct(productId) {
    requireId(productId, 'productId');
    // O item vem da própria exclusão (ALL_OLD), não de uma leitura anterior:
    // um updateProduct entre ler e excluir faria o rollback devolver a versão velha
    let product;
    try {
      product = await this.db.deleteItem('products', { id: productId }, { conditionExpression: 'attribute_exists(id)', returnValues: 'ALL_OLD' });
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') throw new NotFoundError('Product not found');
      throw error;
    }

    try {
      await this.publish('ProductDeleted', { productId, correlationId: generateId('corr') }, { required: true });
    } catch (error) {
      // O erro original é o que importa para quem chamou; falha do rollback só vai para o log
      try {
        await this.db.putItemIfNotExists('products', product);
      } catch (rollbackError) {
        log({ event: 'PRODUCT_DELETE_ROLLBACK_FAILED', status: 'error', message: `Failed to restore product ${productId}`, error: rollbackError });
      }
      throw error;
    }
    return { success: true };
  }

  async publish(detailType, detail, options) {
    if (this.eventBridgeClient) {
      await this.eventBridgeClient.publish({ Source: 'products', DetailType: detailType, Detail: detail }, options);
    }
  }
}

export default ProductSDK;
