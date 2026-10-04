import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { log } from './logger.mjs';

/**
 * Publica eventos de domínio (OrderCreated, PaymentRefunded...) no EventBridge.
 *
 * A maioria dos eventos é informativa (auditoria, e-mail, analytics): o fluxo
 * da compra é controlado pela saga no Step Functions, então uma falha ao
 * publicar é registrada mas não interrompe a operação de negócio.
 *
 * Eventos dos quais outro serviço depende (ex.: ProductCreated, que cria o
 * inventário no Stock) usam `{ required: true }`: a falha é relançada para
 * quem publicou desfazer a operação em vez de deixar os serviços divergentes.
 *
 * Sem EVENT_BUS_NAME (execução local) os eventos são registrados no log e
 * entregues aos assinantes locais (subscribe), no mesmo formato do EventBridge.
 * É assim que o local-server e o e2e fazem o Stock receber ProductCreated.
 */
export class EventBus {
  constructor({ eventBusName = process.env.EVENT_BUS_NAME, client } = {}) {
    this.eventBusName = eventBusName;
    this.subscribers = [];
    if (this.eventBusName) {
      const endpoint = process.env.EVENTBRIDGE_ENDPOINT || process.env.AWS_ENDPOINT;
      this.client = client || new EventBridgeClient({
        region: process.env.AWS_REGION || 'us-east-1',
        ...(endpoint && { endpoint })
      });
    }
  }

  /**
   * Assinante in-process, usado só sem EVENT_BUS_NAME (na AWS quem entrega é
   * uma regra do EventBridge). `fn` recebe o evento no formato do EventBridge.
   */
  subscribe(source, detailType, fn) {
    this.subscribers.push({ source, detailType, fn });
  }

  /**
   * `strictLocalDelivery` (só sem EVENT_BUS_NAME): relança a falha do assinante
   * local. Usado pelo reprocessamento da DLQ, que precisa saber se o Stock
   * processou antes de apagar a mensagem. Na AWS a entrega à regra é assíncrona
   * e não afeta quem publicou, por isso não é o padrão.
   */
  async publish({ Source, DetailType, Detail }, { required = false, strictLocalDelivery = false } = {}) {
    const detail = typeof Detail === 'string' ? JSON.parse(Detail) : Detail;

    if (!this.client) {
      log({
        event: 'DOMAIN_EVENT',
        correlationId: detail?.correlationId,
        status: 'info',
        message: `${Source}/${DetailType} (EVENT_BUS_NAME não definido, entregue só a assinantes locais)`,
        data: detail
      });
      await this.deliverLocally(Source, DetailType, detail, { rethrow: strictLocalDelivery });
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
      if (required) throw error;
    }
  }

  async deliverLocally(source, detailType, detail, { rethrow = false } = {}) {
    const event = { source, 'detail-type': detailType, detail };
    for (const sub of this.subscribers) {
      if (sub.source !== source || sub.detailType !== detailType) continue;
      try {
        await sub.fn(event);
      } catch (error) {
        log({
          event: 'DOMAIN_EVENT_LOCAL_DELIVERY_FAILED',
          correlationId: detail?.correlationId,
          status: 'error',
          message: `Local subscriber failed for ${source}/${detailType}`,
          error
        });
        if (rethrow) throw error;
      }
    }
  }
}

export const eventBus = new EventBus();
