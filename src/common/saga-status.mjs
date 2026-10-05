/**
 * Status da saga e a conversão do resultado da execução do Step Functions
 * para ele. Usado pela API de saga (SagaService, reconciliação) e pela aba
 * Desempenho (SagaMetricsClient), para as duas falarem a mesma língua: o Step
 * Functions marca FAILED toda execução que termina num estado Fail, inclusive
 * a compra compensada (desfeita de propósito: pagamento recusado, sem estoque).
 */
export const SagaStatus = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  COMPENSATING: 'COMPENSATING',
  COMPENSATED: 'COMPENSATED',
  FAILED: 'FAILED',
  COMPENSATION_FAILED: 'COMPENSATION_FAILED'
};

// Error do estado Fail do workflow (scripts/generate-saga-workflow.py)
const STATUS_BY_EXECUTION_ERROR = {
  SagaCompensated: SagaStatus.COMPENSATED,
  SagaFailed: SagaStatus.FAILED,
  CompensationFailed: SagaStatus.COMPENSATION_FAILED
};

/**
 * Status final de uma execução encerrada, ou null se ainda está rodando.
 * `error`: o Error do evento ExecutionFailed. TIMED_OUT/ABORTED e um FAILED
 * sem um dos erros do workflow encerram sem compensar: intervenção manual.
 */
export function finalStatus({ status, error }) {
  if (status === 'RUNNING' || !status) return null;
  if (status === 'SUCCEEDED') return { status: SagaStatus.COMPLETED };
  if (status === 'FAILED' && STATUS_BY_EXECUTION_ERROR[error]) return { status: STATUS_BY_EXECUTION_ERROR[error] };
  return { status: SagaStatus.COMPENSATION_FAILED, error: `Execution${status === 'FAILED' ? `Failed:${error || 'unknown'}` : status}` };
}
