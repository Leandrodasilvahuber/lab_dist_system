import { SagaOrchestratorController } from '../controllers/SagaOrchestratorController.js';

export function setupRoutes(event) {
  const method = event.httpMethod;
  const path = event.path;
  const pathParameters = event.pathParameters;

  // POST /saga/execute
  if (method === 'POST' && path === '/saga/execute') {
    return SagaOrchestratorController.executeSaga(event);
  }

  // GET /saga/{sagaId}
  if (method === 'GET' && path && path.startsWith('/saga/') && pathParameters?.sagaId) {
    return SagaOrchestratorController.getSaga(event);
  }

  // POST /saga/{sagaId}/cancel
  if (method === 'POST' && path && path.match(/\/saga\/[^\/]+\/cancel$/)) {
    const sagaId = path.split('/')[2];
    event.pathParameters = { sagaId };
    return SagaOrchestratorController.cancelSaga(event);
  }

  // POST /saga/rollback/{orderId}
  if (method === 'POST' && path && path.match(/\/saga\/rollback\/[^\/]+$/)) {
    const orderId = path.split('/')[3];
    event.pathParameters = { orderId };
    return SagaOrchestratorController.rollbackSaga(event);
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
        'POST /saga/{sagaId}/cancel',
        'POST /saga/rollback/{orderId}',
        'GET /sagas'
      ]
    })
  };
}
