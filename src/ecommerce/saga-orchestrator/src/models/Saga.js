import { SagaStatus, isValidTransition, canExecuteCompensation, canTerminate } from '../types/SagaStatus.js';
import { SagaStep, SagaStepStatus } from './SagaStep.js';

export class Saga {
  constructor(data) {
    this.id = data.id;
    this.orderId = data.orderId;
    this.sagaDefinition = data.sagaDefinition;
    this.status = data.status || SagaStatus.STARTED;
    this.steps = (data.steps || []).map(stepData => new SagaStep(stepData));
    this.correlationId = data.correlationId;
    this.currentStepIndex = data.currentStepIndex || -1;
    this.totalTime = data.totalTime;
    this.error = data.error;
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }

  toDynamo() {
    return {
      id: this.id,
      orderId: this.orderId,
      sagaDefinition: this.sagaDefinition,
      status: this.status,
      steps: this.steps.map(step => step.toDynamo()),
      correlationId: this.correlationId,
      currentStepIndex: this.currentStepIndex,
      totalTime: this.totalTime,
      error: this.error,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static fromDynamo(item) {
    return new Saga({
      id: item.id,
      orderId: item.orderId,
      sagaDefinition: item.sagaDefinition,
      status: item.status,
      steps: (item.steps || []).map(stepData => SagaStep.fromDynamo(stepData)),
      correlationId: item.correlationId,
      currentStepIndex: item.currentStepIndex,
      totalTime: item.totalTime,
      error: item.error,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    });
  }

  start() {
    if (!isValidTransition(this.status, SagaStatus.EXECUTING)) {
      throw new Error(`Cannot start saga from ${this.status}`);
    }

    this.status = SagaStatus.EXECUTING;
    this.updatedAt = new Date().toISOString();
  }

  fail(failedStepName, error) {
    if (!isValidTransition(this.status, SagaStatus.FAILED)) {
      throw new Error(`Cannot fail saga from ${this.status}`);
    }

    this.status = SagaStatus.FAILED;
    this.error = error;
    this.updatedAt = new Date().toISOString();

    // Mark failed step
    const failedStep = this.steps.find(step => step.stepName === failedStepName);
    if (failedStep) {
      failedStep.fail(error);
    }
  }

  compensate() {
    if (!canExecuteCompensation(this.status)) {
      throw new Error(`Cannot compensate saga from ${this.status}`);
    }

    this.status = SagaStatus.COMPENSATING;
    this.updatedAt = new Date().toISOString();
  }

  completeCompensation() {
    if (!isValidTransition(this.status, SagaStatus.COMPENSATED)) {
      throw new Error(`Cannot complete compensation from ${this.status}`);
    }

    this.status = SagaStatus.COMPENSATED;
    this.updatedAt = new Date().toISOString();
  }

  complete() {
    if (!isValidTransition(this.status, SagaStatus.COMPLETED)) {
      throw new Error(`Cannot complete saga from ${this.status}`);
    }

    this.status = SagaStatus.COMPLETED;
    this.updatedAt = new Date().toISOString();
  }

  getCurrentStep() {
    if (this.currentStepIndex >= 0 && this.currentStepIndex < this.steps.length) {
      return this.steps[this.currentStepIndex];
    }
    return null;
  }

  getNextStep() {
    if (this.currentStepIndex + 1 < this.steps.length) {
      return this.steps[this.currentStepIndex + 1];
    }
    return null;
  }

  incrementStep() {
    this.currentStepIndex++;
    this.updatedAt = new Date().toISOString();
  }

  getCompletedSteps() {
    return this.steps.filter(step => step.status === SagaStepStatus.COMPLETED);
  }

  getFailedSteps() {
    return this.steps.filter(step => step.status === SagaStepStatus.FAILED);
  }

  getStepsToCompensate() {
    return this.steps.slice().reverse().filter(step => step.canCompensate());
  }

  isTerminal() {
    return canTerminate(this.status);
  }

  isExecuting() {
    return this.status === SagaStatus.EXECUTING;
  }

  needsCompensation() {
    return this.status === SagaStatus.FAILED;
  }

  calculateTotalTime() {
    if (this.totalTime) {
      return this.totalTime;
    }

    const firstStep = this.steps[0];
    const lastStep = this.steps[this.steps.length - 1];

    if (firstStep && lastStep && firstStep.startTime && lastStep.endTime) {
      const start = new Date(firstStep.startTime);
      const end = new Date(lastStep.endTime);
      this.totalTime = end - start;
    }

    return this.totalTime;
  }

  startTimer() {
    const firstStep = this.steps[0];
    if (firstStep && !firstStep.startTime) {
      firstStep.start();
    }
  }

  endTimer() {
    const lastStep = this.steps[this.steps.length - 1];
    if (lastStep) {
      lastStep.complete();
    }
  }

  hasStepError(stepName) {
    const step = this.steps.find(s => s.stepName === stepName);
    return step ? step.error : null;
  }

  getProgress() {
    const completedSteps = this.getCompletedSteps().length;
    const totalSteps = this.steps.length;
    return totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;
  }
}
