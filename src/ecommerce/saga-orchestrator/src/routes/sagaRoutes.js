import { SagaOrchestratorController } from '../controllers/SagaOrchestratorController.js';
import { notFoundResponse } from '../../../../common/response.mjs';

export async function setupRoutes(event) {
  const method = event.method;
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

  return notFoundResponse(path, {
    availableEndpoints: ['POST /saga/execute', 'GET /saga/{sagaId}', 'GET /sagas']
  });
}
