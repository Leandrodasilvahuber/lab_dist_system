/**
 * Saga em andamento (RUNNING/COMPENSATING) sem atualização há mais que isto
 * está parada: o pior caso de uma compra é ~5 min (limite de cada passo em
 * scripts/generate-saga-workflow.py). A aba SLOs a conta como travada e o
 * SagaService confere no Step Functions como a execução terminou.
 */
export const STUCK_AFTER_MS = 5 * 60 * 1000;
