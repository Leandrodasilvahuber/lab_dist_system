export const SagaStepStatus = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  COMPENSATING: 'COMPENSATING',
  COMPENSATED: 'COMPENSATED'
};

export const sagaStepStatusTransitions = {
  [SagaStepStatus.PENDING]: [SagaStepStatus.RUNNING, SagaStepStatus.FAILED],
  [SagaStepStatus.RUNNING]: [SagaStepStatus.COMPLETED, SagaStepStatus.FAILED],
  [SagaStepStatus.COMPLETED]: [SagaStepStatus.COMPLETED],
  [SagaStepStatus.FAILED]: [SagaStepStatus.COMPENSATING, SagaStepStatus.FAILED],
  [SagaStepStatus.COMPENSATING]: [SagaStepStatus.COMPENSATED, SagaStepStatus.FAILED],
  [SagaStepStatus.COMPENSATED]: [SagaStepStatus.COMPENSATED]
};

export function isValidStepTransition(fromStatus, toStatus) {
  const validTransitions = sagaStepStatusTransitions[fromStatus];
  return validTransitions && validTransitions.includes(toStatus);
}

export function isTerminalStepStatus(status) {
  return [SagaStepStatus.COMPLETED, SagaStepStatus.FAILED, SagaStepStatus.COMPENSATED].includes(status);
}
