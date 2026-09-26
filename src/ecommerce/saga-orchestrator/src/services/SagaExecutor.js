import { log, createLogContext } from '../../../../common/logger.mjs';
import { Saga, SagaStep } from '../src/models/Saga.js';
import { SagaStatus, SagaStepStatus } from '../src/types/SagaStatus.js';
import { SagaDefinitions } from '../src/constants/SagaDefinitions.js';
import { EventPublisher } from './EventPublisher.js';
import { CompensationHandler } from './CompensationHandler.js';
import { Database } from '../../../../common/database.mjs';
import { EventActions } from '../src/types/Events.js';
import { RetryConfig } from '../src/constants/SagaDefinitions.js';

export class SagaExecutor {
  constructor(sagaId, orderId, correlationId) {
    this.sagaId = sagaId;
    this.orderId = orderId;
    this.correlationId = correlationId;
    this.logContext = createLogContext('SagaExecutor', orderId, correlationId);
    this.db = new Database();
    this.eventPublisher = new EventPublisher(correlationId);
  }

  async executeSaga(productData = {}) {
    try {
      log({
        event: 'SAGA_EXECUTION_STARTED',
        orderId: this.orderId,
        correlationId: this.correlationId,
        status: 'info',
        message: `Starting saga execution for order: ${this.orderId}`,
        data: { sagaId: this.sagaId, orderId: this.orderId }
      });

      // Get saga definition
      const sagaDefinition = SagaDefinitions.getOrderSaga(this.orderId);

      // Create saga
      const saga = new Saga({
        id: this.sagaId,
        orderId: this.orderId,
        sagaDefinition: sagaDefinition,
        status: SagaStatus.STARTED,
        correlationId: this.correlationId,
        steps: sagaDefinition.steps.map((step, index) =>
          new SagaStep({
            id: `step-${index}`,
            sagaId: this.sagaId,
            stepName: step.name,
            action: step.action,
            service: step.service,
            endpoint: step.endpoint,
            method: step.method,
            compensationAction: step.compensationAction,
            status: SagaStepStatus.PENDING,
            correlationId: this.correlationId
          })
        )
      });

      // Save initial saga state
      await this.saveSaga(saga);
      saga.startTimer();

      // Publish saga started event
      await this.eventPublisher.publishEvent('SAGA_STARTED', {
        sagaId: this.sagaId,
        orderId: this.orderId,
        correlationId: this.correlationId,
        totalSteps: saga.steps.length
      });

      // Execute each step
      for (let i = 0; i < saga.steps.length; i++) {
        saga.incrementStep();

        const step = saga.getCurrentStep();
        if (!step) continue;

        // Execute step
        const stepResult = await this.executeStep(step, i, productData);

        if (!stepResult.success) {
          log({
            event: 'SAGA_STEP_FAILED',
            orderId: this.orderId,
            correlationId: this.correlationId,
            status: 'error',
            message: `Step ${step.stepName} failed`,
            data: { stepName: step.stepName, error: stepResult.error }
          });

          // Start compensation
          const compensationHandler = new CompensationHandler(saga, this.eventPublisher);
          await compensationHandler.executeCompensation();

          // Publish saga failed event
          await this.eventPublisher.publishEvent('SAGA_FAILED', {
            sagaId: this.sagaId,
            orderId: this.orderId,
            correlationId: this.correlationId,
            failedStep: step.stepName,
            error: stepResult.error
          });

          // Save final saga state
          await this.saveSaga(saga);

          return {
            success: false,
            saga,
            error: stepResult.error,
            stepsCompleted: i
          };
        }
      }

      // All steps completed successfully
      saga.complete();
      saga.endTimer();
      saga.calculateTotalTime();

      // Publish saga completed event
      await this.eventPublisher.publishEvent('SAGA_COMPLETED', {
        sagaId: this.sagaId,
        orderId: this.orderId,
        correlationId: this.correlationId,
        totalTime: saga.totalTime,
        stepsCompleted: saga.steps.length
      });

      // Save final saga state
      await this.saveSaga(saga);

      log({
        event: 'SAGA_EXECUTION_COMPLETED',
        orderId: this.orderId,
        correlationId: this.correlationId,
        status: 'info',
        message: `Saga execution completed successfully`,
        data: { sagaId: this.sagaId, stepsCompleted: saga.steps.length }
      });

      return {
        success: true,
        saga
      };

    } catch (error) {
      log({
        event: 'SAGA_EXECUTION_ERROR',
        orderId: this.orderId,
        correlationId: this.correlationId,
        status: 'error',
        message: `Saga execution failed with exception`,
        error
      });

      throw error;
    }
  }

  async executeStep(step, stepIndex, productData = {}) {
    try {
      log({
        event: 'SAGA_STEP_EXECUTING',
        orderId: this.orderId,
        correlationId: this.correlationId,
        status: 'info',
        message: `Executing step ${stepIndex + 1}/${stepIndex.length || '?'}: ${step.stepName}`,
        data: { stepName: step.stepName, action: step.action }
      });

      // Update step status to running
      step.start();

      // Publish step started event
      await this.eventPublisher.publishStepResult(
        step.stepName,
        'STEP_STARTED',
        {
          stepName: step.stepName,
          sagaId: this.sagaId,
          orderId: this.orderId,
          action: step.action,
          index: stepIndex
        }
      );

      // Execute step based on its action
      const result = await this.executeStepAction(step, productData);

      if (result.success) {
        step.complete();
        await this.eventPublisher.publishStepResult(
          step.stepName,
          'STEP_COMPLETED',
          {
            stepName: step.stepName,
            sagaId: this.sagaId,
            orderId: this.orderId,
            duration: step.duration
          },
          true
        );

        log({
          event: 'SAGA_STEP_COMPLETED',
          orderId: this.orderId,
          correlationId: this.correlationId,
          status: 'info',
          message: `Step ${step.stepName} completed successfully`,
          data: { stepName: step.stepName, duration: step.duration }
        });

        return { success: true };
      } else {
        step.fail(result.error);
        await this.eventPublisher.publishFailure(step.stepName, result.error, this.orderId);
        return { success: false, error: result.error };
      }

    } catch (error) {
      log({
        event: 'SAGA_STEP_EXCEPTION',
        orderId: this.orderId,
        correlationId: this.correlationId,
        status: 'error',
        message: `Exception during step execution: ${step.stepName}`,
        error
      });

      step.fail(error);
      await this.eventPublisher.publishFailure(step.stepName, error, this.orderId);
      return { success: false, error: error.message || error };
    }
  }

  async executeStepAction(step, productData) {
    try {
      switch (step.action) {
        case EventActions.CREATE_ORDER:
          return await this.createOrder(step, productData);

        case EventActions.PROCESS_PAYMENT:
          return await this.processPayment(step, productData);

        case EventActions.RESERVE_STOCK:
          return await this.reserveStock(step, productData);

        case EventActions.CONFIRM_ORDER:
          return await this.confirmOrder(step, productData);

        default:
          log({
            event: 'UNKNOWN_STEP_ACTION',
            correlationId: this.correlationId,
            status: 'warning',
            message: `Unknown step action: ${step.action}`,
            data: { stepName: step.stepName, action: step.action }
          });

          return { success: true };
      }

    } catch (error) {
      log({
        event: 'STEP_ACTION_FAILED',
        correlationId: this.correlationId,
        status: 'error',
        message: `Failed to execute step action: ${step.action}`,
        data: { stepName: step.stepName, action: step.action, error: error.message }
      });

      return {
        success: false,
        error: error.message || error
      };
    }
  }

  async createOrder(step, productData) {
    log({
      event: 'CREATE_ORDER',
      orderId: this.orderId,
      correlationId: this.correlationId,
      status: 'info',
      message: `Creating order: ${this.orderId}`,
      data: { productId: productData.productId, quantity: productData.quantity }
    });

    // In production, call orders service API
    // For simulation, just log success
    await new Promise(resolve => setTimeout(resolve, 300));

    return { success: true };
  }

  async processPayment(step, productData) {
    log({
      event: 'PROCESS_PAYMENT',
      orderId: this.orderId,
      correlationId: this.correlationId,
      status: 'info',
      message: `Processing payment for order: ${this.orderId}`,
      data: { amount: productData.total }
    });

    // In production, call payments service API
    // For simulation, simulate payment processing
    await new Promise(resolve => setTimeout(resolve, 400));

    // Simulate occasional payment failure
    if (Math.random() < 0.1) {
      throw new Error('Payment processing failed: Insufficient funds');
    }

    return { success: true };
  }

  async reserveStock(step, productData) {
    log({
      event: 'RESERVE_STOCK',
      orderId: this.orderId,
      correlationId: this.correlationId,
      status: 'info',
      message: `Reserving stock for order: ${this.orderId}`,
      data: { productId: productData.productId, quantity: productData.quantity }
    });

    // In production, call stock service API
    // For simulation, simulate occasional stock failure
    await new Promise(resolve => setTimeout(resolve, 200));

    if (Math.random() < 0.1) {
      throw new Error('Stock reservation failed: Insufficient stock');
    }

    return { success: true };
  }

  async confirmOrder(step, productData) {
    log({
      event: 'CONFIRM_ORDER',
      orderId: this.orderId,
      correlationId: this.correlationId,
      status: 'info',
      message: `Confirming order: ${this.orderId}`
    });

    // In production, call orders service API
    // For simulation, just log success
    await new Promise(resolve => setTimeout(resolve, 200));

    return { success: true };
  }

  async saveSaga(saga) {
    try {
      await this.db.putItem('sagas', saga.toDynamo());
      log({
        event: 'SAGA_SAVED',
        orderId: this.orderId,
        correlationId: this.correlationId,
        status: 'info',
        message: `Saga state saved: ${saga.id}`,
        data: { sagaId: saga.id, status: saga.status, stepsCompleted: saga.getCompletedSteps().length }
      });
    } catch (error) {
      log({
        event: 'SAGA_SAVE_FAILED',
        orderId: this.orderId,
        correlationId: this.correlationId,
        status: 'error',
        message: `Failed to save saga state`,
        error
      });
      throw error;
    }
  }

  async retryStep(step, stepIndex) {
    // Implement retry logic with exponential backoff
    if (step.retryCount >= RetryConfig.MAX_RETRIES) {
      throw new Error(`Max retries (${RetryConfig.MAX_RETRIES}) exceeded for step: ${step.stepName}`);
    }

    step.retry(`Retry attempt ${step.retryCount + 1}`);

    const delayMs = RetryConfig.RETRY_DELAY_MS * Math.pow(RetryConfig.RETRY_BACKOFF_FACTOR, step.retryCount - 1);

    log({
      event: 'SAGA_STEP_RETRY',
      orderId: this.orderId,
      correlationId: this.correlationId,
      status: 'info',
      message: `Retrying step: ${step.stepName} (attempt ${step.retryCount})`,
      data: { stepName: step.stepName, delayMs }
    });

    await new Promise(resolve => setTimeout(resolve, delayMs));

    return this.executeStep(step, stepIndex);
  }
}
