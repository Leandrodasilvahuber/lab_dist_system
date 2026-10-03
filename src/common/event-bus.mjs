import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { log } from './logger.mjs';

/**
 * Publica eventos de domínio (OrderCreated, PaymentRefunded...) no EventBridge.
 *
 * Os eventos são informativos: avisam o resto do sistema sobre o que aconteceu
 * (auditoria, e-mail, analytics). O fluxo da compra é controlado pela saga no
 * Step Functions, então uma falha ao publicar é registrada mas não interrompe
 * a operação de negócio.
 *
 * Sem EVENT_BUS_NAME (execução local) os eventos são apenas registrados no log.
 */
export class EventBus {
  constructor({ eventBusName = process.env.EVENT_BUS_NAME, client } = {}) {
    this.eventBusName = eventBusName;
    if (this.eventBusName) {
      const endpoint = process.env.EVENTBRIDGE_ENDPOINT || process.env.AWS_ENDPOINT;
      this.client = client || new EventBridgeClient({
        region: process.env.AWS_REGION || 'us-east-1',
        ...(endpoint && { endpoint })
      });
    }
  }

  async publish({ Source, DetailType, Detail }) {
    const detail = typeof Detail === 'string' ? JSON.parse(Detail) : Detail;

    if (!this.client) {
      log({
        event: 'DOMAIN_EVENT',
        correlationId: detail?.correlationId,
        status: 'info',
        message: `${Source}/${DetailType} (EVENT_BUS_NAME não definido, evento não enviado)`,
        data: detail
      });
      return;
    }

    try {
      const result = await this.client.send(new PutEventsCommand({
        Entries: [{
          EventBusName: this.eventBusName,
          Source,
          DetailType,
          Detail: JSON.stringify(detail)
        }]
      }));
      if (result.FailedEntryCount > 0) {
        throw new Error(result.Entries?.[0]?.ErrorMessage || 'PutEvents failed');
      }
    } catch (error) {
      log({
        event: 'DOMAIN_EVENT_PUBLISH_FAILED',
        correlationId: detail?.correlationId,
        status: 'error',
        message: `Failed to publish ${Source}/${DetailType}`,
        error
      });
    }
  }
}

export const eventBus = new EventBus();
