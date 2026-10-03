import { SagaOrchestratorController } from '../controllers/SagaOrchestratorController.js';

export async function setupRoutes(event) {
  const method = event.httpMethod;
  const path = event.path;
  const sagaMatch = path.match(/^\/saga\/([^/]+)$/);

  // POST /saga/execute
  if (method === 'POST' && path === '/saga/execute') {
    return SagaOrchestratorController.executeSaga(event);
  }

  // GET /saga/{sagaId}
  if (method === 'GET' && sagaMatch) {
    event.pathParameters = { ...event.pathParameters, sagaId: decodeURIComponent(sagaMatch[1]) };
    return SagaOrchestratorController.getSaga(event);
  }

  // GET /sagas
  if (method === 'GET' && path === '/sagas') {
    return SagaOrchestratorController.getSagas(event);
  }

  return {
    statusCode: 404,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({
      error: 'Not found',
      path: path,
      availableEndpoints: [
        'POST /saga/execute',
        'GET /saga/{sagaId}',
        'GET /sagas'
      ]
    })
  };
}
