import { setupRoutes } from './src/routes/paymentRoutes.js';
import { log, createLogContext } from '../../common/logger.mjs';

export async function handler(event) {
  try {
    const { correlationId } = event.headers || {};

    log({
      event: 'API_REQUEST',
      correlationId,
      status: 'info',
      message: `Incoming request: ${event.httpMethod} ${event.path}`
    });

    const response = setupRoutes(event);

    log({
      event: 'API_RESPONSE',
      correlationId,
      status: 'info',
      message: `Response status: ${response.statusCode}`
    });

    return response;

  } catch (error) {
    log({
      event: 'API_ERROR',
      correlationId: event.headers?.correlationId,
      status: 'error',
      message: 'API request error',
      error
    });

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Internal server error'
      })
    };
  }
}