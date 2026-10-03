import { setupRoutes } from './src/routes/sagaRoutes.js';
import { log } from '../../common/logger.mjs';
import { normalizeHttpEvent } from '../../common/http-event.mjs';

export async function handler(rawEvent) {
  const event = normalizeHttpEvent(rawEvent);

  try {
    const { correlationId } = event.headers || {};

    log({
      event: 'API_REQUEST',
      correlationId,
      status: 'info',
      message: `Incoming saga orchestrator request: ${event.httpMethod} ${event.path}`
    });

    const response = await setupRoutes(event);

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
