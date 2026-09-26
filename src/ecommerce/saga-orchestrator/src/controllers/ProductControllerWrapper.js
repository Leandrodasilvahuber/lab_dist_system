import { Product } from '../../products/src/models/Product.js';
import { Database } from '../../../../../common/database.mjs';
import { successResponse, errorResponse } from '../../../../../common/response.mjs';

const db = new Database();

/**
 * Wrapper para ProductController - necessário pois saga orchestrator acessa produtos diretamente
 */
export class ProductController {
  /**
   * Buscar produto por ID
   */
  static async getProducts(event, queryStringParameters) {
    try {
      const { correlationId, idempotencyKey } = event.headers || {};

      if (queryStringParameters?.id) {
        const product = await db.getItem('products', { id: queryStringParameters.id });

        if (!product) {
          return errorResponse('Product not found', 404);
        }

        const productInstance = Product.fromDynamo(product);

        return successResponse(productInstance);
      }

      const products = await db.scanItems('products');
      const productInstances = products.map(p => Product.fromDynamo(p));

      return successResponse(productInstances);

    } catch (error) {
      return errorResponse('Failed to get products', 500, error);
    }
  }

  /**
   * Criar produto
   */
  static async createProduct(event) {
    try {
      const { correlationId, idempotencyKey } = event.headers || {};
      const { name, price, description, stock = 0 } = JSON.parse(event.body);

      if (!name || !price) {
        return errorResponse('Missing required fields: name, price', 400);
      }

      const productId = `product-${Date.now()}`;
      const product = new Product({
        id: productId,
        name,
        price: parseFloat(price),
        description: description || '',
        stock: parseInt(stock),
        createdAt: new Date().toISOString()
      });

      await db.putItem('products', product.toDynamo());

      return successResponse(product, 201);

    } catch (error) {
      return errorResponse('Failed to create product', 500, error);
    }
  }
}
