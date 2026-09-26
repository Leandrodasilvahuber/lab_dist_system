import { Stock } from '../models/Stock.js';
import { Database } from '../../../../common/database.mjs';
import { successResponse, errorResponse } from '../../../../common/response.mjs';

const db = new Database();

export class StockController {
  static async getStock(event) {
    try {
      const { productId } = event.pathParameters || {};
      const { limit = 10, offset = 0 } = event.queryStringParameters || {};

      if (productId) {
        const stock = await db.getItem('stock', { id: productId });
        if (!stock) {
          return errorResponse('Stock not found', 404);
        }

        const stockInstance = Stock.fromDynamo(stock);
        return successResponse(stockInstance);
      } else {
        const stocks = await db.scanItems('stock', {
          Limit: parseInt(limit),
          ExclusiveStartKey: offset ? { id: offset } : undefined
        });

        const stockInstances = stocks.map(item => Stock.fromDynamo(item));
        return successResponse(stockInstances);
      }

    } catch (error) {
      return errorResponse('Failed to get stock', 500, error);
    }
  }

  static async reserveStock(event) {
    try {
      const { productId } = event.pathParameters || {};
      const { correlationId, idempotencyKey } = event.headers || {};
      const { quantity } = JSON.parse(event.body) || {};

      if (!productId || !quantity) {
        return errorResponse('Missing required fields: productId, quantity', 400);
      }

      const stock = await db.getItem('stock', { id: productId });
      if (!stock) {
        return errorResponse('Stock not found', 404);
      }

      const stockInstance = Stock.fromDynamo(stock);

      if (!stockInstance.canReserve(parseInt(quantity))) {
        return errorResponse(`Insufficient stock. Available: ${stockInstance.available}, Required: ${quantity}`, 400);
      }

      const reservationId = `reservation-${Date.now()}`;

      // Update stock with reservation
      stockInstance.reserve(parseInt(quantity));
      await db.putItem('stock', stockInstance.toDynamo());

      const reservation = {
        id: reservationId,
        productId,
        quantity: parseInt(quantity),
        status: 'RESERVED',
        correlationId,
        idempotencyKey,
        createdAt: new Date().toISOString()
      };

      await db.putItem('stock_reservations', reservation);

      return successResponse({
        reservationId,
        productId,
        quantity: parseInt(quantity),
        status: 'RESERVED',
        available: stockInstance.available
      });

    } catch (error) {
      return errorResponse('Failed to reserve stock', 500, error);
    }
  }

  static async releaseStock(event) {
    try {
      const { productId } = event.pathParameters || {};
      const { correlationId, idempotencyKey } = event.headers || {};
      const { reservationId, quantity } = JSON.parse(event.body) || {};

      if (!productId || !reservationId || !quantity) {
        return errorResponse('Missing required fields: productId, reservationId, quantity', 400);
      }

      // Verify the reservation exists
      const reservation = await db.getItem('stock_reservations', { id: reservationId });
      if (!reservation) {
        return errorResponse('Reservation not found', 404);
      }

      if (reservation.productId !== productId) {
        return errorResponse('Reservation does not match product ID', 400);
      }

      // Get current stock
      const stock = await db.getItem('stock', { id: productId });
      if (!stock) {
        return errorResponse('Stock not found', 404);
      }

      const stockInstance = Stock.fromDynamo(stock);

      // Release the reservation
      stockInstance.release(parseInt(quantity));
      await db.putItem('stock', stockInstance.toDynamo());

      // Update reservation status
      await db.updateItem('stock_reservations', { id: reservationId },
        'SET #status = :status, updatedAt = :now',
        {
          ':status': 'RELEASED',
          ':now': new Date().toISOString(),
          '#status': 'status'
        }
      );

      return successResponse({
        reservationId,
        productId,
        quantity: parseInt(quantity),
        status: 'RELEASED',
        available: stockInstance.available
      });

    } catch (error) {
      return errorResponse('Failed to release stock', 500, error);
    }
  }

  static async adjustStock(event) {
    try {
      const { productId } = event.pathParameters || {};
      const { correlationId, idempotencyKey } = event.headers || {};
      const { newQuantity } = JSON.parse(event.body) || {};

      if (!productId || newQuantity === undefined) {
        return errorResponse('Missing required fields: productId, newQuantity', 400);
      }

      const stock = await db.getItem('stock', { id: productId });
      if (!stock) {
        return errorResponse('Stock not found', 404);
      }

      const stockInstance = Stock.fromDynamo(stock);

      stockInstance.adjustQuantity(parseInt(newQuantity));
      await db.putItem('stock', stockInstance.toDynamo());

      return successResponse({
        productId,
        newQuantity: parseInt(newQuantity),
        reserved: stockInstance.reserved,
        available: stockInstance.available,
        updatedAt: stockInstance.updatedAt
      });

    } catch (error) {
      return errorResponse('Failed to adjust stock', 500, error);
    }
  }

  // Compensating action for saga orchestration
  static async releaseStockForSaga(productId, quantity) {
    try {
      // Get current stock
      const stock = await db.getItem('stock', { id: productId });
      if (!stock) {
        return { success: false, error: 'Stock not found' };
      }

      const stockInstance = Stock.fromDynamo(stock);

      // Check if stock can be released (must have reserved quantity)
      if (stockInstance.reserved < quantity) {
        return { success: false, error: 'Cannot release stock: insufficient reserved quantity' };
      }

      // Release the stock
      stockInstance.release(parseInt(quantity));
      await db.putItem('stock', stockInstance.toDynamo());

      return { success: true, stock: stockInstance };

    } catch (error) {
      return { success: false, error: error.message || error };
    }
  }
}