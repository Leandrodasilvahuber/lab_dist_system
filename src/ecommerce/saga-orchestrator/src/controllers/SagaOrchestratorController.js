// Step Functions client implementation is currently disabled
import { eventPublisher } from '../src/services/EventPublisher.js';
import { SagaStatus } from '../src/types/SagaStatus.js';
import { log, createLogContext } from '../../../../common/logger.mjs';
import { successResponse, errorResponse } from '../../../../common/response.mjs';

export class SagaOrchestratorController {
  static async executeSaga(event) {
    try {
      const { correlationId, idempotencyKey } = event.headers || {};
      const body = event.body ? JSON.parse(event.body) : {};
      const { orderId, productId, quantity } = body;

      log({
        event: 'SAGA_EXECUTE_REQUEST',
        correlationId,
        status: 'info',
        message: `Execute saga request received`,
        data: { orderId, productId, quantity }
      });

      // Validate required fields
      if (!orderId || !productId || quantity === undefined) {
        return errorResponse('Missing required fields: orderId, productId, quantity', 400);
      }

      // Validate quantity
      if (quantity <= 0) {
        return errorResponse('Quantity must be greater than 0', 400);
      }

      // Validar se produto existe
      const ProductFunction = (await import('../src/controllers/ProductController.js')).default;
      const productResult = await ProductFunction.getProducts(event, { id: productId });

      if (productResult.statusCode === 404 || (productResult.body && JSON.parse(productResult.body).items?.length === 0)) {
        return errorResponse(`Product not found: ${productId}`, 404);
      }

      const product = JSON.parse(productResult.body).items?.[0];
      const total = product.price * quantity;

      log({
        event: 'SAGA_VALIDATION_SUCCESS',
        orderId,
        productId,
        quantity,
        total,
        correlationId,
        status: 'info'
      });

      // Iniciar saga via Step Functions
      const result = await stepFunctionsClient.startExecution({
        orderId,
        productId,
        quantity: parseInt(quantity),
        total
      });

      log({
        event: 'SAGA_EXECUTE_SUCCESS',
        sagaId: result.sagaId,
        orderId,
        correlationId,
        status: 'info',
        message: `Saga started successfully via Step Functions`,
        executionArn: result.executionArn
      });

      return successResponse({
        sagaId: result.sagaId,
        executionArn: result.executionArn,
        status: 'RUNNING',
        orderId,
        correlationId
      }, 202);

    } catch (error) {
      log({
        event: 'SAGA_EXECUTE_EXCEPTION',
        correlationId: event.headers?.correlationId,
        status: 'error',
        message: 'Saga execution exception',
        error
      });

      return errorResponse(`Saga execution error: ${error.message}`, 500, error);
    }
  }

  static async getSaga(event) {
    try {
      const { sagaId } = event.pathParameters;
      const { correlationId } = event.headers || {};

      log({
        event: 'SAGA_GET_REQUEST',
        sagaId,
        correlationId,
        status: 'info',
        message: `Get saga request received`
      });

      if (!sagaId) {
        return errorResponse('Missing required field: sagaId', 400);
      }

      // Buscar no DynamoDB
      const sagaData = await stepFunctionsClient.getSagaById(sagaId);

      if (!sagaData) {
        return errorResponse('Saga not found', 404);
      }

      log({
        event: 'SAGA_GET_SUCCESS',
        sagaId,
        correlationId,
        status: 'info',
        message: `Saga retrieved successfully`,
        data: { sagaId, status: sagaData.status }
      });

      return successResponse(sagaData);

    } catch (error) {
      log({
        event: 'SAGA_GET_EXCEPTION',
        sagaId: event.pathParameters?.sagaId,
        correlationId: event.headers?.correlationId,
        status: 'error',
        message: 'Get saga exception',
        error
      });

      return errorResponse(`Get saga error: ${error.message}`, 500, error);
    }
  }

  static async cancelSaga(event) {
    try {
      const { sagaId } = event.pathParameters;
      const { correlationId } = event.headers || {};

      log({
        event: 'SAGA_CANCEL_REQUEST',
        sagaId,
        correlationId,
        status: 'info',
        message: `Cancel saga request received`
      });

      if (!sagaId) {
        return errorResponse('Missing required field: sagaId', 400);
      }

      // In a real implementation, this would cancel an in-progress saga
      // For now, we'll mark it as failed
      const db = new Database();
      const sagaData = await db.getItem('sagas', { id: sagaId });

      if (!sagaData) {
        return errorResponse('Saga not found', 404);
      }

      const saga = new Saga(sagaData);

      if (saga.isTerminal()) {
        return errorResponse('Cannot cancel terminal saga', 400);
      }

      // Trigger compensation
      const CompensationHandler = (await import('../src/services/CompensationHandler.js')).default;
      const CompensationHandlerInstance = new CompensationHandler(saga, null);
      await CompensationHandlerInstance.executeCompensation();

      log({
        event: 'SAGA_CANCEL_SUCCESS',
        sagaId,
        correlationId,
        status: 'info',
        message: `Saga cancelled and compensated`,
        data: { sagaId, status: saga.status }
      });

      return successResponse({
        sagaId: saga.id,
        orderId: saga.orderId,
        status: saga.status,
        correlationId
      });

    } catch (error) {
      log({
        event: 'SAGA_CANCEL_EXCEPTION',
        sagaId: event.pathParameters?.sagaId,
        correlationId: event.headers?.correlationId,
        status: 'error',
        message: 'Cancel saga exception',
        error
      });

      return errorResponse(`Cancel saga error: ${error.message}`, 500, error);
    }
  }

  static async rollbackSaga(event) {
    try {
      const { orderId } = event.pathParameters;
      const { correlationId } = event.headers || {};

      log({
        event: 'SAGA_ROLLBACK_REQUEST',
        orderId,
        correlationId,
        status: 'info',
        message: `Rollback saga request received`
      });

      if (!orderId) {
        return errorResponse('Missing required field: orderId', 400);
      }

      // Find saga by orderId
      const db = new Database();
      const sagaData = await db.getItem('sagas', { id: `saga-${orderId}` });

      if (!sagaData) {
        return errorResponse('Saga not found for this order', 404);
      }

      const saga = new Saga(sagaData);

      if (saga.isTerminal()) {
        return successResponse({
          sagaId: saga.id,
          orderId: saga.orderId,
          status: saga.status,
          message: 'Saga already completed or failed'
        });
      }

      // Trigger compensation
      const CompensationHandler = (await import('../src/services/CompensationHandler.js')).default;
      const CompensationHandlerInstance = new CompensationHandler(saga, null);
      await CompensationHandlerInstance.executeCompensation();

      log({
        event: 'SAGA_ROLLBACK_SUCCESS',
        orderId,
        correlationId,
        status: 'info',
        message: `Saga rollback completed`,
        data: { sagaId: saga.id, status: saga.status }
      });

      return successResponse({
        sagaId: saga.id,
        orderId: saga.orderId,
        status: saga.status,
        correlationId,
        message: 'Saga rollback completed'
      });

    } catch (error) {
      log({
        event: 'SAGA_ROLLBACK_EXCEPTION',
        orderId: event.pathParameters?.orderId,
        correlationId: event.headers?.correlationId,
        status: 'error',
        message: 'Rollback saga exception',
        error
      });

      return errorResponse(`Rollback saga error: ${error.message}`, 500, error);
    }
  }

  static async getSagas(event) {
    try {
      const { correlationId } = event.headers || {};

      log({
        event: 'SAGAS_GET_REQUEST',
        correlationId,
        status: 'info',
        message: `Get all sagas request received`
      });

      const db = new Database();
      const sagasData = await db.scanItems('sagas');

      log({
        event: 'SAGAS_GET_SUCCESS',
        correlationId,
        status: 'info',
        message: `Sagas retrieved successfully`,
        data: { count: sagasData.length }
      });

      return successResponse({
        sagas: sagasData,
        count: sagasData.length
      });

    } catch (error) {
      log({
        event: 'SAGAS_GET_EXCEPTION',
        correlationId: event.headers?.correlationId,
        status: 'error',
        message: 'Get sagas exception',
        error
      });

      return errorResponse(`Get sagas error: ${error.message}`, 500, error);
    }
  }
}
