import { DynamoDBClientClass } from '../../common/database.js';

/**
 * SDK Público - Interface uniforme para operações de produto
 * Saga orchestrator usa isso, não importa diretamente do products
 */
export class ProductSDK {
  constructor(eventBridgeClient) {
    this.eventBridgeClient = eventBridgeClient;
  }

  /**
   * Criar produto
   * Saga Orchestrator chama via EventBridge
   */
  async createProduct(productData) {
    const correlationId = generateCorrelationId();

    // Em produção, publicar evento via EventBridge
    if (this.eventBridgeClient) {
      await this.eventBridgeClient.publish({
        Source: 'products',
        DetailType: 'CreateProduct',
        Detail: JSON.stringify({
          ...productData,
          correlationId
        })
      });
    }

    // Criar no banco local para saga orchestrator
    const product = {
      id: generateId(),
      ...productData,
      createdAt: new Date().toISOString()
    };

    await Database.putItem('Products', product);
    return product;
  }

  /**
   * Buscar produto por ID
   */
  async getProduct(productId) {
    const product = await Database.getItem('Products', { id: productId });
    if (!product) {
      throw new Error('Product not found');
    }
    return product;
  }

  /**
   * Listar produtos
   */
  async listProducts(filters = {}) {
    const allProducts = await DynamoDBClientClass.queryItems('Products');
    return allProducts.filter(product => {
      if (filters.name && !product.name.toLowerCase().includes(filters.name.toLowerCase())) {
        return false;
      }
      if (filters.priceMin && product.price < filters.priceMin) {
        return false;
      }
      if (filters.priceMax && product.price > filters.priceMax) {
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
    await Database.putItem('Products', updatedProduct);
    return updatedProduct;
  }

  /**
   * Deletar produto
   */
  async deleteProduct(productId) {
    await this.getProduct(productId); // Verifica se existe
    await Database.delete('Products', productId);
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