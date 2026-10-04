import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { awsClientConfig } from '../../../../common/aws-client.mjs';

/**
 * Cliente mínimo do Step Functions usado para iniciar a saga.
 */
export class StepFunctionsClient {
  constructor({
    stateMachineArn = process.env.SAGA_STATE_MACHINE_ARN,
    client
  } = {}) {
    this.stateMachineArn = stateMachineArn;
    this.client = client || new SFNClient(awsClientConfig('STEPFUNCTIONS_ENDPOINT'));
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
