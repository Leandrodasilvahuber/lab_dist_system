import { Database } from '../database.mjs';
import { NotFoundError } from '../errors.mjs';

/**
 * SDK Público - Interface uniforme para operações de produto
 * Saga orchestrator usa isso, não importa diretamente do products
 */
export class ProductSDK {
  constructor(eventBridgeClient, db = new Database()) {
    this.eventBridgeClient = eventBridgeClient;
    this.db = db;
  }

  /**
   * Criar produto
   */
  async createProduct(productData) {
    const product = {
      id: generateId(),
      ...productData,
      createdAt: new Date().toISOString()
    };

    await this.db.putItem('products', product);

    if (this.eventBridgeClient) {
      await this.eventBridgeClient.publish({
        Source: 'products',
        DetailType: 'ProductCreated',
        Detail: { productId: product.id, name: product.name, correlationId: generateCorrelationId() }
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
   */
  async updateProduct(productId, updates) {
    const product = await this.getProduct(productId);
    const updatedProduct = {
      ...product,
      ...updates,
      updatedAt: new Date().toISOString()
    };
    await this.db.putItem('products', updatedProduct);
    return updatedProduct;
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