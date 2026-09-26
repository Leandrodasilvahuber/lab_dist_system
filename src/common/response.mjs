export function successResponse(body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Idempotency-Key, X-Correlation-ID'
    },
    body: JSON.stringify(body)
  };
}

export function errorResponse(message, statusCode = 500, error = null) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true
    },
    body: JSON.stringify({
      error: message,
      details: error ? error.message || error : undefined
    })
  };
}

// Wrapper functions for testing compatibility
export function createSuccessResponse(event, body) {
  return successResponse(body, 200);
}

export function createErrorResponse(event, error, statusCode = 500) {
  return errorResponse(
    error?.message || error?.message || 'Internal server error',
    statusCode,
    error
  );
}

export function createOkResponse(event, body = {}) {
  return successResponse(body, 200);
}

export function createNotFoundResponse(event, message) {
  return errorResponse(message || 'Resource not found', 404);
}

export function createConflictResponse(event, message) {
  return errorResponse(message || 'Resource already exists', 409);
}