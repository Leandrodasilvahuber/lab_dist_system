import {
  successResponse,
  errorResponse,
  createSuccessResponse,
  createErrorResponse,
  createOkResponse,
  createNotFoundResponse,
  createConflictResponse
} from '../../../src/common/response.mjs';
import { jest } from 'jest';

describe('Response Module', () => {
  describe('successResponse', () => {
    test('should return success response with default status', () => {
      const body = { message: 'Success' };
      const response = successResponse(body);

      expect(response).toEqual({
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': true,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Idempotency-Key, X-Correlation-ID'
        },
        body: JSON.stringify(body)
      });
    });

    test('should return success response with custom status', () => {
      const body = { message: 'Created' };
      const response = successResponse(body, 201);

      assert.strictEqual(response.statusCode, 201);
      assert.strictEqual(response.body, JSON.stringify(body));
    });
  });

  describe('errorResponse', () => {
    test('should return error response with default status', () => {
      const message = 'Server error';
      const response = errorResponse(message);

      expect(response).toEqual({
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': true
        },
        body: JSON.stringify({
          error: message,
          details: undefined
        })
      });
    });

    test('should return error response with custom status and error', () => {
      const message = 'Not found';
      const error = new Error('Resource not found');
      const response = errorResponse(message, 404, error);

      assert.strictEqual(response.statusCode, 404);
      expect(response.body).toBe(JSON.stringify({
        error: message,
        details: 'Resource not found'
      }));
    });

    test('should handle null error details', () => {
      const message = 'Error without details';
      const response = errorResponse(message, 400, null);

      expect(response.body).toBe(JSON.stringify({
        error: message,
        details: undefined
      }));
    });
  });

  describe('createSuccessResponse', () => {
    test('should create success response from event', () => {
      const event = { headers: {} };
      const body = { data: 'test' };
      const response = createSuccessResponse(event, body);

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.body, JSON.stringify(body));
    });
  });

  describe('createErrorResponse', () => {
    test('should create error response from event with error', () => {
      const event = { headers: {} };
      const error = new Error('Test error');
      const response = createErrorResponse(event, error, 400);

      assert.strictEqual(response.statusCode, 400);
      expect(response.body).toBe(JSON.stringify({
        error: 'Test error',
        details: 'Test error'
      }));
    });

    test('should handle string error', () => {
      const event = { headers: {} };
      const response = createErrorResponse(event, 'String error', 400);

      expect(response.body).toBe(JSON.stringify({
        error: 'String error',
        details: 'String error'
      }));
    });

    test('should use default error message', () => {
      const event = { headers: {} };
      const response = createErrorResponse(event, null, 500);

      expect(response.body).toBe(JSON.stringify({
        error: 'Internal server error',
        details: undefined
      }));
    });
  });

  describe('createOkResponse', () => {
    test('should create ok response with empty body', () => {
      const event = { headers: {} };
      const response = createOkResponse(event);

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.body, '{}');
    });

    test('should create ok response with custom body', () => {
      const event = { headers: {} };
      const body = { status: 'ok' };
      const response = createOkResponse(event, body);

      assert.strictEqual(response.body, JSON.stringify(body));
    });
  });

  describe('createNotFoundResponse', () => {
    test('should create not found response with default message', () => {
      const event = { headers: {} };
      const response = createNotFoundResponse(event);

      assert.strictEqual(response.statusCode, 404);
      expect(response.body).toBe(JSON.stringify({
        error: 'Resource not found'
      }));
    });

    test('should create not found response with custom message', () => {
      const event = { headers: {} };
      const message = 'Product not found';
      const response = createNotFoundResponse(event, message);

      expect(response.body).toBe(JSON.stringify({
        error: message
      }));
    });
  });

  describe('createConflictResponse', () => {
    test('should create conflict response with default message', () => {
      const event = { headers: {} };
      const response = createConflictResponse(event);

      assert.strictEqual(response.statusCode, 409);
      expect(response.body).toBe(JSON.stringify({
        error: 'Resource already exists'
      }));
    });

    test('should create conflict response with custom message', () => {
      const event = { headers: {} };
      const message = 'Order already exists';
      const response = createConflictResponse(event, message);

      expect(response.body).toBe(JSON.stringify({
        error: message
      }));
    });
  });

  describe('CORS Headers', () => {
    test('should include all required CORS headers in success response', () => {
      const response = successResponse({});

      expect(response.headers).toEqual({
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Idempotency-Key, X-Correlation-ID'
      });
    });

    test('should include basic CORS headers in error response', () => {
      const response = errorResponse('Error');

      expect(response.headers).toEqual({
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true
      });
    });
  });
});