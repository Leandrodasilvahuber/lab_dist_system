import { Database } from '../database.mjs';
import { NotFoundError, ValidationError } from '../errors.mjs';

/**
 * SDK Público - Interface uniforme para operações de produto
 *
 * A tabela `products` guarda só o catálogo (nome, preço, descrição). A
 * quantidade em estoque pertence ao serviço de Stock: o estoque inicial segue
 * no evento ProductCreated e o Stock cria o inventário a partir dele.
 */
export class ProductSDK {
  constructor(eventBridgeClient, db = new Database()) {
    this.eventBridgeClient = eventBridgeClient;
    this.db = db;
  }

  /**
   * Criar produto
   */
  async createProduct({ initialStock = 0, ...productData }) {
    const now = new Date().toISOString();
    const product = {
      id: generateId(),
      ...productData,
      createdAt: now,
      updatedAt: now
    };

    await this.db.putItem('products', product);

    if (this.eventBridgeClient) {
      await this.eventBridgeClient.publish({
        Source: 'products',
        DetailType: 'ProductCreated',
        Detail: { productId: product.id, name: product.name, initialStock, correlationId: generateCorrelationId() }
      });
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
   * Listar produtos
   */
  async listProducts(filters = {}) {
    const allProducts = await this.db.scanItems('products');
    return allProducts.filter(product => {
      if (filters.name && !(product.name || '').toLowerCase().includes(filters.name.toLowerCase())) {
        return false;
      }
      if (filters.priceMin && product.price < Number(filters.priceMin)) {
        return false;
      }
      if (filters.priceMax && product.price > Number(filters.priceMax)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Atualizar produto
   * Altera só os campos enviados (UpdateItem), sem regravar o item inteiro.
   */
  async updateProduct(productId, updates) {
    if ('stock' in updates) {
      throw new ValidationError('stock is managed by the stock service');
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
   */
  async deleteProduct(productId) {
    await this.getProduct(productId); // Verifica se existe
    await this.db.deleteItem('products', { id: productId });
    return { success: true };
  }
}

/**
 * Gerar ID único
 */
function generateId() {
  return `prod_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Gerar ID de correlação
 */
function generateCorrelationId() {
  return `corr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export default ProductSDK;