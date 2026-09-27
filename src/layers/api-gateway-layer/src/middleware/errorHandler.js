import { errorResponse } from '../shared/response.mjs';

export function errorHandler(error, event) {
  console.error('Error:', error);

  // Tratamento específico para erros conhecidos
  if (error.status === 404) {
    return {
      statusCode: 404,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Not Found',
        message: error.message || 'Resource not found'
      })
    };
  }

  if (error.status === 400) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Bad Request',
        message: error.message || 'Invalid request'
      })
    };
  }

  // Erro genérico
  return {
    statusCode: 500,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({
      error: 'Internal Server Error',
      message: error.message || 'An unexpected error occurred'
    })
  };
}