import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

/**
 * Cliente mínimo do Step Functions usado para iniciar a saga.
 */
export class StepFunctionsClient {
  constructor({
    stateMachineArn = process.env.SAGA_STATE_MACHINE_ARN,
    client
  } = {}) {
    this.stateMachineArn = stateMachineArn;
    const endpoint = process.env.STEPFUNCTIONS_ENDPOINT || process.env.AWS_ENDPOINT;
    this.client = client || new SFNClient({
      region: process.env.AWS_REGION || 'us-east-1',
      ...(endpoint && { endpoint })
    });
  }

  async startExecution(name, input) {
    if (!this.stateMachineArn) {
      throw new Error('SAGA_STATE_MACHINE_ARN is not configured');
    }

    const { executionArn } = await this.client.send(new StartExecutionCommand({
      stateMachineArn: this.stateMachineArn,
      name,
      input: JSON.stringify(input)
    }));
    return executionArn;
  }
}
