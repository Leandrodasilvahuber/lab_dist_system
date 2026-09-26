export const SagaStatus = {
  STARTED: 'STARTED',
  EXECUTING: 'EXECUTING',
  FAILED: 'FAILED',
  COMPENSATING: 'COMPENSATING',
  COMPENSATED: 'COMPENSATED',
  COMPLETED: 'COMPLETED'
};

export const sagaStatusTransitions = {
  [SagaStatus.STARTED]: [SagaStatus.EXECUTING],
  [SagaStatus.EXECUTING]: [SagaStatus.FAILED, SagaStatus.COMPENSATING, SagaStatus.COMPLETED],
  [SagaStatus.FAILED]: [],
  [SagaStatus.COMPENSATING]: [SagaStatus.COMPENSATED, SagaStatus.FAILED],
  [SagaStatus.COMPENSATED]: [SagaStatus.COMPLETED],
  [SagaStatus.COMPLETED]: []
};

export function isValidTransition(fromStatus, toStatus) {
  const validTransitions = sagaStatusTransitions[fromStatus];
  return validTransitions && validTransitions.includes(toStatus);
}

export function canExecuteCompensation(status) {
  return [SagaStatus.EXECUTING, SagaStatus.FAILED, SagaStatus.COMPENSATING].includes(status);
}

export function canTerminate(status) {
  return [SagaStatus.COMPLETED, SagaStatus.FAILED, SagaStatus.COMPENSATED].includes(status);
}
