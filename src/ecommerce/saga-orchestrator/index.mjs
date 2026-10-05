import { createServiceHandler } from '../../common/http-handler.mjs';
import { setupRoutes } from './src/routes/sagaRoutes.js';
import { SagaOrchestratorController } from './src/controllers/SagaOrchestratorController.js';

export const handler = createServiceHandler({
  setupRoutes,
  // Disparada pelo agendamento ReconcileSagas (template.yaml)
  actions: { reconcileStuckSagas: () => SagaOrchestratorController.reconcileStuckSagas() }
});
