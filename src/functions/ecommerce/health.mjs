import { successResponse, errorResponse } from '../../shared/response.mjs';
import { log, createLogContext } from '../../shared/logger.mjs';

export async function handler(event) {
  try {
    const { correlationId } = event.headers || {};

    log({
      event: 'HEALTH_CHECK_START',
      correlationId,
      status: 'info',
      message: 'Starting health check'
    });

    const health = {
      status: 'ok',
      service: 'distributed-systems-playground',
      timestamp: new Date().toISOString()
    };

    log({
      event: 'HEALTH_CHECK_SUCCESS',
      correlationId,
      status: 'success',
      message: 'Health check passed'
    });

    return successResponse(health);

  } catch (error) {
    log({
      event: 'HEALTH_CHECK_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'Health check failed',
      error
    });

    return errorResponse('Health check failed', 500, error);
  }
}