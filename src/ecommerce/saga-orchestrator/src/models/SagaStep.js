import { SagaStepStatus, isValidStepTransition, isTerminalStepStatus } from '../types/SagaStepStatus.js';

export { SagaStepStatus, SagaStep };

export class SagaStep {
  constructor(data) {
    this.id = data.id;
    this.sagaId = data.sagaId;
    this.stepName = data.stepName;
    this.action = data.action;
    this.service = data.service;
    this.endpoint = data.endpoint;
    this.method = data.method;
    this.compensationAction = data.compensationAction;
    this.status = data.status || SagaStepStatus.PENDING;
    this.startTime = data.startTime;
    this.endTime = data.endTime;
    this.duration = data.duration;
    this.error = data.error;
    this.retryCount = data.retryCount || 0;
    this.retryAttempts = data.retryAttempts || [];
    this.correlationId = data.correlationId;
  }

  toDynamo() {
    return {
      id: this.id,
      sagaId: this.sagaId,
      stepName: this.stepName,
      action: this.action,
      service: this.service,
      endpoint: this.endpoint,
      method: this.method,
      compensationAction: this.compensationAction,
      status: this.status,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.duration,
      error: this.error,
      retryCount: this.retryCount,
      retryAttempts: this.retryAttempts,
      correlationId: this.correlationId
    };
  }

  static fromDynamo(item) {
    return new SagaStep({
      id: item.id,
      sagaId: item.sagaId,
      stepName: item.stepName,
      action: item.action,
      service: item.service,
      endpoint: item.endpoint,
      method: item.method,
      compensationAction: item.compensationAction,
      status: item.status,
      startTime: item.startTime,
      endTime: item.endTime,
      duration: item.duration,
      error: item.error,
      retryCount: item.retryCount,
      retryAttempts: item.retryAttempts || [],
      correlationId: item.correlationId
    });
  }

  start() {
    if (!isValidStepTransition(this.status, SagaStepStatus.RUNNING)) {
      throw new Error(`Cannot start step from ${this.status}`);
    }

    this.status = SagaStepStatus.RUNNING;
    this.startTime = new Date().toISOString();
    this.duration = null;
    this.error = null;
  }

  complete() {
    if (!isValidStepTransition(this.status, SagaStepStatus.COMPLETED)) {
      throw new Error(`Cannot complete step from ${this.status}`);
    }

    this.status = SagaStepStatus.COMPLETED;
    this.endTime = new Date().toISOString();
    this.duration = this.calculateDuration();
  }

  fail(error) {
    if (!isValidStepTransition(this.status, SagaStepStatus.FAILED)) {
      throw new Error(`Cannot fail step from ${this.status}`);
    }

    this.status = SagaStepStatus.FAILED;
    this.endTime = new Date().toISOString();
    this.duration = this.calculateDuration();
    this.error = error;
  }

  compensate(error) {
    if (!isValidStepTransition(this.status, SagaStepStatus.COMPENSATING)) {
      throw new Error(`Cannot compensate step from ${this.status}`);
    }

    this.status = SagaStepStatus.COMPENSATING;
    this.startTime = new Date().toISOString();
    this.duration = null;
    this.error = error;
  }

  completeCompensation() {
    if (!isValidStepTransition(this.status, SagaStepStatus.COMPENSATED)) {
      throw new Error(`Cannot complete compensation from ${this.status}`);
    }

    this.status = SagaStepStatus.COMPENSATED;
    this.endTime = new Date().toISOString();
    this.duration = this.calculateDuration();
  }

  retry(error) {
    this.retryCount++;
    this.retryAttempts.push({
      attempt: this.retryCount,
      timestamp: new Date().toISOString(),
      error: error
    });
  }

  calculateDuration() {
    if (!this.startTime || !this.endTime) {
      return null;
    }

    const start = new Date(this.startTime);
    const end = new Date(this.endTime);
    return end - start;
  }

  isTerminal() {
    return isTerminalStepStatus(this.status);
  }

  needsRetry() {
    return this.status === SagaStepStatus.FAILED;
  }

  canCompensate() {
    return [SagaStepStatus.COMPLETED, SagaStepStatus.FAILED].includes(this.status);
  }
}
