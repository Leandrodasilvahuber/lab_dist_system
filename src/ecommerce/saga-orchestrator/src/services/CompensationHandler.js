import { log, createLogContext } from '../../../../common/logger.mjs';
import { EventPublisher } from './EventPublisher.js';
import { SagaStep, SagaStepStatus } from '../models/SagaStep.js';
import { CompensationConfig } from '../constants/SagaDefinitions.js';

export class CompensationHandler {
  constructor(saga, eventPublisher) {
    this.saga = saga;
    this.eventPublisher = eventPublisher;
    this.logContext = createLogContext('CompensationHandler', saga.orderId, saga.correlationId);
    this.compensatedSteps = 0;
    this.compensationErrors = [];
  }

  async executeCompensation() {
    try {
      log({
        event: 'COMPENSATION_STARTED',
        orderId: this.saga.orderId,
        correlationId: this.saga.correlationId,
        status: 'info',
        message: `Starting compensation for saga ${this.saga.id}`,
        data: { stepsToCompensate: this.saga.getStepsToCompensate().length }
      });

      this.saga.compensate();

      const stepsToCompensate = this.saga.getStepsToCompensate();

      if (stepsToCompensate.length === 0) {
        log({
          event: 'NO_STEPS_TO_COMPENSATE',
          orderId: this.saga.orderId,
          correlationId: this.saga.correlationId,
          status: 'warning',
          message: 'No steps to compensate'
        });

        this.saga.completeCompensation();
        return this.saga;
      }

      log({
        event: 'COMPENSATION_FLOW',
        orderId: this.saga.orderId,
        correlationId: this.saga.correlationId,
        status: 'info',
        message: `Executing ${stepsToCompensate.length} compensation steps`,
        data: { steps: stepsToCompensate.map(s => s.stepName) }
      });

      // Execute compensation in reverse order
      for (const step of stepsToCompensate) {
        const compensationResult = await this.executeCompensationStep(step);

        if (compensationResult.success) {
          this.compensatedSteps++;
          log({
            event: 'COMPENSATION_STEP_SUCCESS',
            orderId: this.saga.orderId,
            correlationId: this.saga.correlationId,
            status: 'info',
            message: `Successfully compensated step: ${step.stepName}`,
            data: { stepName: step.stepName }
          });
        } else {
          this.compensationErrors.push({
            stepName: step.stepName,
            error: compensationResult.error
          });
          log({
            event: 'COMPENSATION_STEP_FAILED',
            orderId: this.saga.orderId,
            correlationId: this.saga.correlationId,
            status: 'error',
            message: `Failed to compensate step: ${step.stepName}`,
            data: { stepName: step.stepName, error: compensationResult.error }
          });
        }

        // Wait before next compensation step
        if (this.compensationErrors.length === 0 && stepsToCompensate.indexOf(step) < stepsToCompensate.length - 1) {
          await this.delay(CompensationConfig.COMPENSATION_DELAY_MS);
        }
      }

      if (this.compensationErrors.length > 0) {
        this.saga.fail(this.compensationErrors[0].stepName, `Compensation failed: ${this.compensationErrors[0].error}`);
        log({
          event: 'COMPENSATION_PARTIAL_SUCCESS',
          orderId: this.saga.orderId,
          correlationId: this.saga.correlationId,
          status: 'warning',
          message: `Compensation completed with errors. Compensated: ${this.compensatedSteps}/${stepsToCompensate.length}`,
          data: { errors: this.compensationErrors }
        });
      } else {
        this.saga.completeCompensation();
        log({
          event: 'COMPENSATION_COMPLETE',
          orderId: this.saga.orderId,
          correlationId: this.saga.correlationId,
          status: 'info',
          message: `Compensation completed successfully. All ${this.compensatedSteps} steps compensated`,
          data: { compensatedSteps: this.compensatedSteps }
        });
      }

      return this.saga;

    } catch (error) {
      log({
        event: 'COMPENSATION_FAILED',
        orderId: this.saga.orderId,
        correlationId: this.saga.correlationId,
        status: 'error',
        message: 'Compensation handler failed',
        error
      });

      this.saga.fail('COMPENSATION_HANDLER', error);
      throw error;
    }
  }

  async executeCompensationStep(step) {
    try {
      // Update step status
      step.compensate();

      log({
        event: 'COMPENSATION_STEP_EXECUTING',
        orderId: this.saga.orderId,
        correlationId: this.saga.correlationId,
        status: 'info',
        message: `Executing compensation for step: ${step.stepName}`,
        data: { stepName: step.stepName, compensationAction: step.compensationAction }
      });

      // Publish compensation started event
      await this.eventPublisher.publishCompensationResult(step.stepName, true);

      // Execute compensation action based on step configuration
      const compensationResult = await this.executeCompensationAction(step);

      // Update step status
      if (compensationResult.success) {
        step.completeCompensation();
      } else {
        step.completeCompensation();
      }

      // Publish compensation result
      await this.eventPublisher.publishCompensationResult(
        step.stepName,
        compensationResult.success,
        compensationResult.error
      );

      return {
        success: compensationResult.success,
        error: compensationResult.error
      };

    } catch (error) {
      log({
        event: 'COMPENSATION_STEP_EXCEPTION',
        orderId: this.saga.orderId,
        correlationId: this.saga.correlationId,
        status: 'error',
        message: `Exception during compensation for step: ${step.stepName}`,
        error
      });

      // Update step with error
      step.completeCompensation();
      await this.eventPublisher.publishCompensationResult(step.stepName, false, error);

      return {
        success: false,
        error: error.message || error
      };
    }
  }

  async executeCompensationAction(step) {
    try {
      switch (step.compensationAction) {
        case 'CANCEL_ORDER':
          return await this.cancelOrder(step);

        case 'REFUND_PAYMENT':
          return await this.refundPayment(step);

        case 'RELEASE_STOCK':
          return await this.releaseStock(step);

        default:
          log({
            event: 'UNKNOWN_COMPENSATION_ACTION',
            correlationId: this.saga.correlationId,
            status: 'warning',
            message: `Unknown compensation action: ${step.compensationAction}`,
            data: { compensationAction: step.compensationAction }
          });

          // Return success as we've already published the event
          return { success: true };
      }

    } catch (error) {
      log({
        event: 'COMPENSATION_ACTION_FAILED',
        correlationId: this.saga.correlationId,
        status: 'error',
        message: `Failed to execute compensation action: ${step.compensationAction}`,
        data: { compensationAction: step.compensationAction, error: error.message }
      });

      return {
        success: false,
        error: error.message || error
      };
    }
  }

  async cancelOrder(step) {
    log({
      event: 'COMPENSATION_CANCEL_ORDER',
      orderId: this.saga.orderId,
      correlationId: this.saga.correlationId,
      status: 'info',
      message: `Cancelling order: ${this.saga.orderId}`
    });

    try {
      // Call orders service API to cancel order
      const orderController = (await import('../../../../ecommerce/orders/src/controllers/OrderController.js')).default;

      const result = await orderController.cancelOrderForSaga(this.saga.orderId);

      if (result.success) {
        log({
          event: 'ORDER_CANCEL_SUCCESS',
          orderId: this.saga.orderId,
          correlationId: this.saga.correlationId,
          status: 'info',
          message: 'Order cancelled successfully',
          data: { orderId: this.saga.orderId }
        });

        return { success: true };
      } else {
        log({
          event: 'ORDER_CANCEL_FAILED',
          orderId: this.saga.orderId,
          correlationId: this.saga.correlationId,
          status: 'error',
          message: `Failed to cancel order: ${result.error}`,
          data: { orderId: this.saga.orderId, error: result.error }
        });

        return { success: false, error: result.error };
      }
    } catch (error) {
      log({
        event: 'ORDER_CANCEL_EXCEPTION',
        orderId: this.saga.orderId,
        correlationId: this.saga.correlationId,
        status: 'error',
        message: `Exception cancelling order: ${error.message}`,
        error
      });

      return { success: false, error: error.message || error };
    }
  }

  async refundPayment(step) {
    log({
      event: 'COMPENSATION_REFUND_PAYMENT',
      orderId: this.saga.orderId,
      correlationId: this.saga.correlationId,
      status: 'info',
      message: `Refunding payment for order: ${this.saga.orderId}`
    });

    try {
      // Get payment amount from step data or use order total
      const amount = step.amount || this.saga.total || 100; // Default to 100 if not specified

      // Call payments service API to refund payment
      const paymentController = (await import('../../../../ecommerce/payments/src/controllers/PaymentController.js')).default;

      const result = await paymentController.refundPaymentForSaga(this.saga.orderId);

      if (result.success) {
        log({
          event: 'PAYMENT_REFUND_SUCCESS',
          orderId: this.saga.orderId,
          correlationId: this.saga.correlationId,
          status: 'info',
          message: 'Payment refunded successfully',
          data: { orderId: this.saga.orderId, refundId: result.payment?.id }
        });

        return { success: true };
      } else {
        log({
          event: 'PAYMENT_REFUND_FAILED',
          orderId: this.saga.orderId,
          correlationId: this.saga.correlationId,
          status: 'error',
          message: `Failed to refund payment: ${result.error}`,
          data: { orderId: this.saga.orderId, error: result.error }
        });

        return { success: false, error: result.error };
      }
    } catch (error) {
      log({
        event: 'PAYMENT_REFUND_EXCEPTION',
        orderId: this.saga.orderId,
        correlationId: this.saga.correlationId,
        status: 'error',
        message: `Exception refunding payment: ${error.message}`,
        error
      });

      return { success: false, error: error.message || error };
    }
  }

  async releaseStock(step) {
    log({
      event: 'COMPENSATION_RELEASE_STOCK',
      orderId: this.saga.orderId,
      correlationId: this.saga.correlationId,
      status: 'info',
      message: `Releasing stock reservation for order: ${this.saga.orderId}`
    });

    try {
      // Get the quantity from step data
      const quantity = step.quantity || 1; // Default to 1 if not specified

      // Call stock service API to release stock
      const stockController = (await import('../../../../ecommerce/stock/src/controllers/StockController.js')).default;

      const result = await stockController.releaseStockForSaga(this.saga.productId, quantity);

      if (result.success) {
        log({
          event: 'STOCK_RELEASE_SUCCESS',
          orderId: this.saga.orderId,
          correlationId: this.saga.correlationId,
          status: 'info',
          message: `Stock released successfully for product: ${this.saga.productId}`,
          data: { productId: this.saga.productId, quantity, available: result.stock?.available }
        });

        return { success: true };
      } else {
        log({
          event: 'STOCK_RELEASE_FAILED',
          orderId: this.saga.orderId,
          correlationId: this.saga.correlationId,
          status: 'error',
          message: `Failed to release stock: ${result.error}`,
          data: { productId: this.saga.productId, quantity, error: result.error }
        });

        return { success: false, error: result.error };
      }
    } catch (error) {
      log({
        event: 'STOCK_RELEASE_EXCEPTION',
        orderId: this.saga.orderId,
        correlationId: this.saga.correlationId,
        status: 'error',
        message: `Exception releasing stock: ${error.message}`,
        error
      });

      return { success: false, error: error.message || error };
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
