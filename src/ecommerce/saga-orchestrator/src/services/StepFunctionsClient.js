import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { awsClientConfig } from '../../../../common/aws-client.mjs';

/**
 * Cliente mínimo do Step Functions: inicia a saga e consulta como a execução
 * terminou (reconciliação do status, SagaService.reconcile).
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

  /**
   * ARN da execução pelo nome, para quando o executionArn não foi gravado
   * (SAGA_ARN_NOT_RECORDED): arn:...:stateMachine:<máquina> vira
   * arn:...:execution:<máquina>:<nome>
   */
  executionArn(name) {
    if (!this.stateMachineArn) {
      throw new Error('SAGA_STATE_MACHINE_ARN is not configured');
    }
    return `${this.stateMachineArn.replace(':stateMachine:', ':execution:')}:${name}`;
  }

  async describeExecution(executionArn) {
    const { status, error, cause, stopDate } = await this.client.send(new DescribeExecutionCommand({ executionArn }));
    return { status, error, cause, stopDate };
  }
}
