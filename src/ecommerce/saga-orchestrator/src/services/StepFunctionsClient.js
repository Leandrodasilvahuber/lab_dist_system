import { StepFunctions } from '@aws-sdk/client-sfn';
import { log, createLogContext } from '../../../../common/logger.mjs';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

/**
 * Cliente para interagir com AWS Step Functions
 */
export class StepFunctionsClient {
  constructor(region = process.env.AWS_REGION || 'us-east-1') {
    this.client = new StepFunctions({ region });
    this.dynamodbClient = DynamoDBDocument.from(new DynamoDB({ region }));

    // Nome do state machine - pode vir de environment variable
    this.stateMachineArn = process.env.SAGA_STATE_MACHINE_ARN ||
      `arn:aws:states:${region}:${process.env.AWS_ACCOUNT_ID}:stateMachine:OrderSagaWorkflow`;
  }

  /**
   * Iniciar uma nova execução de saga
   */
  async startExecution(input) {
    const correlationId = createLogContext();
    const sagaId = `saga-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    log({
      event: 'SAGA_START_EXECUTION',
      sagaId,
      status: 'info',
      message: 'Starting saga execution in Step Functions',
      correlationId,
      input
    });

    try {
      const command = new StartExecutionCommand({
        stateMachineArn: this.stateMachineArn,
        name: sagaId,
        input: JSON.stringify({
          sagaId,
          orderId: input.orderId,
          productId: input.productId,
          quantity: input.quantity,
          timestamp: new Date().toISOString(),
          correlationId
        })
      });

      const result = await this.client.send(command);

      log({
        event: 'SAGA_EXECUTION_STARTED',
        sagaId,
        status: 'success',
        message: 'Saga execution started in Step Functions',
        statusArn: result.executionArn,
        correlationId
      });

      // Salvar no DynamoDB para tracking
      await this.saveSaga(sagaId, {
        id: sagaId,
        orderId: input.orderId,
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
        statusArn: result.executionArn,
        input
      });

      return {
        sagaId,
        executionArn: result.executionArn,
        statusArn: result.executionArn
      };

    } catch (error) {
      log({
        event: 'SAGA_START_EXECUTION_ERROR',
        sagaId,
        status: 'error',
        message: 'Failed to start saga execution',
        error: error.message,
        correlationId
      });

      throw new Error(`Failed to start saga execution: ${error.message}`);
    }
  }

  /**
   * Buscar status de uma execução de saga
   */
  async describeExecution(executionArn) {
    const correlationId = createLogContext();

    log({
      event: 'SAGA_DESCRIBE_EXECUTION',
      executionArn,
      status: 'info',
      message: 'Describing saga execution',
      correlationId
    });

    try {
      const command = new DescribeExecutionCommand({ executionArn });
      const result = await this.client.send(command);

      // Atualizar no DynamoDB se existir
      if (result.executionArn) {
        const sagaId = result.executionArn.split(':').pop();
        await this.updateSagaStatus(sagaId, {
          status: result.status,
          stoppedAt: result.stoppedAt,
          statusDetails: result.statusDetails
        });
      }

      log({
        event: 'SAGA_EXECUTION_DESCRIBED',
        executionArn,
        status: 'success',
        message: 'Saga execution described successfully',
        status: result.status,
        correlationId
      });

      return {
        status: result.status,
        startDate: result.startDate,
        stopDate: result.stopDate,
        output: result.output ? JSON.parse(result.output) : null,
        errorMessage: result.errorMessage,
        errorCause: result.errorCause
      };

    } catch (error) {
      log({
        event: 'SAGA_DESCRIBE_EXECUTION_ERROR',
        executionArn,
        status: 'error',
        message: 'Failed to describe saga execution',
        error: error.message,
        correlationId
      });

      throw new Error(`Failed to describe saga execution: ${error.message}`);
    }
  }

  /**
   * Cancelar uma execução de saga
   */
  async stopExecution(executionArn, error) {
    const correlationId = createLogContext();

    log({
      event: 'SAGA_STOP_EXECUTION',
      executionArn,
      status: 'info',
      message: 'Stopping saga execution',
      error,
      correlationId
    });

    try {
      const command = new StopExecutionCommand({
        executionArn,
        error,
        cause: `Manual stop: ${error}`
      });

      const result = await this.client.send(command);

      log({
        event: 'SAGA_EXECUTION_STOPPED',
        executionArn,
        status: 'success',
        message: 'Saga execution stopped successfully',
        correlationId
      });

      return result;

    } catch (error) {
      log({
        event: 'SAGA_STOP_EXECUTION_ERROR',
        executionArn,
        status: 'error',
        message: 'Failed to stop saga execution',
        error: error.message,
        correlationId
      });

      throw new Error(`Failed to stop saga execution: ${error.message}`);
    }
  }

  /**
   * Salvar saga no DynamoDB
   */
  async saveSaga(sagaId, sagaData) {
    const { ENVIRONMENT } = process.env;
    const tableName = `${ENVIRONMENT}-Sagas`;

    try {
      await this.dynamodbClient.put({
        TableName: tableName,
        Item: {
          id: sagaId,
          ...sagaData,
          updatedAt: new Date().toISOString()
        }
      });

      log({
        event: 'SAGA_SAVED',
        sagaId,
        status: 'success',
        message: 'Saga saved to DynamoDB',
        tableName,
        correlationId: createLogContext()
      });

    } catch (error) {
      log({
        event: 'SAGA_SAVE_ERROR',
        sagaId,
        status: 'error',
        message: 'Failed to save saga to DynamoDB',
        error: error.message,
        tableName,
        correlationId: createLogContext()
      });

      throw error;
    }
  }

  /**
   * Atualizar status da saga
   */
  async updateSagaStatus(sagaId, updates) {
    const { ENVIRONMENT } = process.env;
    const tableName = `${ENVIRONMENT}-Sagas`;

    try {
      await this.dynamodbClient.update({
        TableName: tableName,
        Key: { id: sagaId },
        UpdateExpression: 'SET #s = :s, #ut = :ut, #od = :od',
        ExpressionAttributeNames: {
          '#s': 'status',
          '#ut': 'updatedAt',
          '#od': 'stoppedAt'
        },
        ExpressionAttributeValues: {
          ':s': updates.status,
          ':ut': new Date().toISOString(),
          ':od': updates.stoppedAt || undefined
        }
      });

      log({
        event: 'SAGA_STATUS_UPDATED',
        sagaId,
        status: 'success',
        message: 'Saga status updated',
        tableName,
        status: updates.status,
        correlationId: createLogContext()
      });

    } catch (error) {
      log({
        event: 'SAGA_STATUS_UPDATE_ERROR',
        sagaId,
        status: 'error',
        message: 'Failed to update saga status',
        error: error.message,
        tableName,
        correlationId: createLogContext()
      });

      throw error;
    }
  }

  /**
   * Obter saga pelo ID
   */
  async getSagaById(sagaId) {
    const { ENVIRONMENT } = process.env;
    const tableName = `${ENVIRONMENT}-Sagas`;

    try {
      const result = await this.dynamodbClient.get({
        TableName: tableName,
        Key: { id: sagaId }
      });

      return result.Item;

    } catch (error) {
      log({
        event: 'SAGA_GET_ERROR',
        sagaId,
        status: 'error',
        message: 'Failed to get saga',
        error: error.message,
        correlationId: createLogContext()
      });

      throw error;
    }
  }

  /**
   * Listar todas as sagas
   */
  async listSagas(limit = 50) {
    const { ENVIRONMENT } = process.env;
    const tableName = `${ENVIRONMENT}-Sagas`;

    try {
      const result = await this.dynamodbClient.scan({
        TableName: tableName,
        Limit: limit
      });

      return result.Items;

    } catch (error) {
      log({
        event: 'SAGAS_LIST_ERROR',
        status: 'error',
        message: 'Failed to list sagas',
        error: error.message,
        correlationId: createLogContext()
      });

      throw error;
    }
  }
}

// Importação dinâmica dos comandos
const { StartExecutionCommand, DescribeExecutionCommand, StopExecutionCommand } =
  await import('@aws-sdk/client-sfn');

// Expor instância singleton
export const stepFunctionsClient = new StepFunctionsClient();
