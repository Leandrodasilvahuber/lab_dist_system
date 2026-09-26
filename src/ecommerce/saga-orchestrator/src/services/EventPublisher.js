import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { validateEvent } from '../src/types/Events.js';
import { successResponse, errorResponse } from '../../../../common/response.mjs';
import { log, createLogContext } from '../../../../common/logger.mjs';

export class EventPublisher {
  constructor(region = process.env.AWS_REGION || 'us-east-1') {
    this.client = new EventBridgeClient({ region });
    this.eventBusName = process.env.EVENT_BUS_NAME || 'OrderEventsBus';
    this.correlationId = createLogContext();
  }

  /**
   * Publicar evento genérico para EventBridge
   */
  async publishEvent(eventType, eventData, eventService = null) {
    try {
      // Validate event
      validateEvent(eventType, eventData);

      const event = {
        source: eventService || 'sagas',
        detailType: eventType,
        detail: eventData,
        correlationId: this.correlationId,
        timestamp: new Date().toISOString()
      };

      log({
        event: `PUBLISHING_EVENT`,
        orderId: eventData.orderId,
        correlationId: this.correlationId,
        status: 'info',
        message: `Publishing ${eventType} event`,
        data: { eventType, service: eventService }
      });

      // Enviar para EventBridge
      await this.sendToEventBridge(event);

      log({
        event: `EVENT_PUBLISHED`,
        orderId: eventData.orderId,
        correlationId: this.correlationId,
        status: 'info',
        message: `Successfully published ${eventType} event`
      });

      return successResponse({ status: 'published', eventType, correlationId: this.correlationId });

    } catch (error) {
      log({
        event: `EVENT_PUBLISH_FAILED`,
        orderId: eventData.orderId,
        correlationId: this.correlationId,
        status: 'error',
        message: `Failed to publish ${eventType} event`,
        error
      });

      throw error;
    }
  }

  async publishStepResult(stepName, eventType, eventData, success = true, error = null) {
    try {
      const eventDataWithStep = {
        ...eventData,
        stepName,
        success,
        timestamp: new Date().toISOString()
      };

      if (error) {
        eventDataWithStep.error = error;
      }

      await this.publishEvent(eventType, eventDataWithStep);

      return successResponse({
        stepName,
        eventType,
        success,
        correlationId: this.correlationId
      });

    } catch (error) {
      log({
        event: 'STEP_RESULT_FAILED',
        correlationId: this.correlationId,
        status: 'error',
        message: `Failed to publish step result for ${stepName}`,
        error
      });
      throw error;
    }
  }

  async publishFailure(stepName, error, orderId = null) {
    try {
      const failureData = {
        stepName,
        error: error.message || error,
        orderId,
        timestamp: new Date().toISOString()
      };

      await this.publishEvent('STEP_FAILED', failureData);

      log({
        event: 'FAILURE_PUBLISHED',
        orderId,
        correlationId: this.correlationId,
        status: 'error',
        message: `Published failure for step: ${stepName}`,
        data: { stepName, error: error.message }
      });

      return successResponse({
        stepName,
        error: error.message,
        correlationId: this.correlationId
      });

    } catch (error) {
      log({
        event: 'FAILURE_PUBLISH_FAILED',
        correlationId: this.correlationId,
        status: 'error',
        message: `Failed to publish failure for step: ${stepName}`,
        error
      });
      throw error;
    }
  }

  async publishCompensationResult(stepName, success = true, error = null) {
    try {
      const compensationData = {
        stepName,
        success,
        timestamp: new Date().toISOString()
      };

      if (error) {
        compensationData.error = error.message || error;
      }

      const eventType = success ? 'COMPENSATION_SUCCESS' : 'COMPENSATION_FAILED';
      await this.publishEvent(eventType, compensationData);

      log({
        event: 'COMPENSATION_RESULT_PUBLISHED',
        correlationId: this.correlationId,
        status: success ? 'info' : 'error',
        message: `Published ${eventType} for step: ${stepName}`,
        data: { stepName, success }
      });

      return successResponse({
        stepName,
        eventType,
        success,
        correlationId: this.correlationId
      });

    } catch (error) {
      log({
        event: 'COMPENSATION_RESULT_PUBLISH_FAILED',
        correlationId: this.correlationId,
        status: 'error',
        message: `Failed to publish compensation result for step: ${stepName}`,
        error
      });
      throw error;
    }
  }

  /**
   * Enviar evento para EventBridge
   */
  async sendToEventBridge(event) {
    try {
      const command = new PutEventsCommand({
        Entries: [{
          EventBusName: this.eventBusName,
          Source: event.source,
          DetailType: event.detailType,
          Detail: JSON.stringify(event.detail),
          Time: new Date()
        }]
      });

      const result = await this.client.send(command);

      log({
        event: 'EVENT_BRIDGE_SEND',
        source: event.source,
        detailType: event.detailType,
        status: 'info',
        message: 'Event sent to EventBridge',
        correlationId: this.correlationId,
        entriesSent: result.Entries?.length || 0,
        entriesFailed: result.Entries?.filter(e => e?.ErrorCode)?.length || 0
      });

      return result;

    } catch (error) {
      log({
        event: 'EVENT_BRIDGE_SEND_ERROR',
        source: event.source,
        detailType: event.detailType,
        status: 'error',
        message: 'Failed to send event to EventBridge',
        error: error.message,
        correlationId: this.correlationId
      });

      // Não lançar erro - eventos são fire-and-forget
      return { failedEntryCount: 1, entries: [] };
    }
  }
}

// Instância singleton
export const eventPublisher = new EventPublisher();
