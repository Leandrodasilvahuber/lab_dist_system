import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand
} from '@aws-sdk/client-sqs';
import { eventBus as defaultEventBus } from '../../../../common/event-bus.mjs';
import { NotFoundError, ValidationError } from '../../../../common/errors.mjs';

const BATCH = 10;
const MAX_BATCHES = 5;
// Tempo em que a mensagem fica escondida enquanto é reprocessada/descartada
const LOCK_SECONDS = 30;

/**
 * Lista, reprocessa e descarta os eventos da ProductEventsDlq para a aba DLQ
 * do dashboard.
 *
 * A fila recebe mensagens de duas origens:
 *  - DeadLetterConfig da regra do EventBridge (falha ao entregar à Lambda):
 *    o body é o evento original e o motivo vem nos atributos ERROR_CODE /
 *    ERROR_MESSAGE;
 *  - destino OnFailure da StockFunction (a Lambda falhou em todas as
 *    tentativas): o body é o registro da invocação, com o evento em
 *    `requestPayload` e o erro em `responsePayload`.
 */
export class DlqClient {
  constructor({ queueUrl = process.env.DLQ_URL, queueName = process.env.DLQ_NAME, client, eventBus = defaultEventBus } = {}) {
    this.queueUrl = queueUrl;
    this.queueName = queueName;
    this.eventBus = eventBus;
    const endpoint = process.env.SQS_ENDPOINT || process.env.AWS_ENDPOINT;
    this.client = client || new SQSClient({
      region: process.env.AWS_REGION || 'us-east-1',
      ...(endpoint && { endpoint })
    });
  }

  // Na AWS a URL vem do template; no local, só o nome. Fila inexistente -> null
  async resolveQueueUrl() {
    if (this.queueUrl) return this.queueUrl;
    if (!this.queueName) throw new Error('DLQ_URL or DLQ_NAME must be configured');
    try {
      const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
      this.queueUrl = QueueUrl;
      return QueueUrl;
    } catch (error) {
      if (error.name === 'QueueDoesNotExist' || error.name === 'AWS.SimpleQueueService.NonExistentQueue') return null;
      throw error;
    }
  }

  receive(QueueUrl, VisibilityTimeout) {
    return this.client.send(new ReceiveMessageCommand({
      QueueUrl,
      MaxNumberOfMessages: BATCH,
      VisibilityTimeout,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['SentTimestamp', 'ApproximateReceiveCount']
    })).then(({ Messages = [] }) => Messages);
  }

  async listMessages() {
    const QueueUrl = await this.resolveQueueUrl();
    if (!QueueUrl) return { queue: this.queueName, approximateTotal: 0, messages: [] };

    const { Attributes = {} } = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl, AttributeNames: ['ApproximateNumberOfMessages']
    }));

    // VisibilityTimeout 0: só espia, as mensagens continuam visíveis na fila
    const seen = new Map();
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const messages = await this.receive(QueueUrl, 0);
      const fresh = messages.filter(m => !seen.has(m.MessageId));
      fresh.forEach(m => seen.set(m.MessageId, toEntry(m)));
      if (!fresh.length) break;
    }

    return {
      queue: this.queueName || QueueUrl.split('/').pop(),
      approximateTotal: Number(Attributes.ApproximateNumberOfMessages || seen.size),
      messages: [...seen.values()].sort((a, b) => (a.sentAt || '').localeCompare(b.sentAt || ''))
    };
  }

  /**
   * Recebe as mensagens (escondidas por LOCK_SECONDS) até achar a do id; as
   * outras voltam a ficar visíveis na hora. Devolve { message, QueueUrl }.
   */
  async lock(messageId) {
    const QueueUrl = await this.resolveQueueUrl();
    if (!QueueUrl) throw new NotFoundError('DLQ message not found');

    const others = [];
    let found = null;
    try {
      for (let batch = 0; batch < MAX_BATCHES && !found; batch++) {
        const messages = await this.receive(QueueUrl, LOCK_SECONDS);
        if (!messages.length) break;
        for (const message of messages) {
          if (!found && message.MessageId === messageId) found = message;
          else others.push(message);
        }
      }
    } finally {
      await Promise.all(others.map(m => this.release(QueueUrl, m)));
    }
    if (!found) throw new NotFoundError('DLQ message not found');
    return { message: found, QueueUrl };
  }

  release(QueueUrl, message) {
    return this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0
    })).catch(() => {});
  }

  /**
   * Republica o evento original (o EventBridge entrega de novo ao Stock) e só
   * então apaga a mensagem. Se a republicação falhar, a mensagem volta para a fila.
   */
  async redrive(messageId) {
    const { message, QueueUrl } = await this.lock(messageId);
    const entry = toEntry(message);
    if (!entry.source || !entry.detailType) {
      await this.release(QueueUrl, message);
      throw new ValidationError('Message is not an EventBridge event and cannot be redriven');
    }
    try {
      await this.eventBus.publish(
        { Source: entry.source, DetailType: entry.detailType, Detail: entry.detail },
        { required: true, strictLocalDelivery: true }
      );
    } catch (error) {
      await this.release(QueueUrl, message);
      throw error;
    }
    await this.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
    return entry;
  }

  async discard(messageId) {
    const { message, QueueUrl } = await this.lock(messageId);
    await this.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
    return toEntry(message);
  }
}

function toEntry(message) {
  let body = {};
  try {
    body = JSON.parse(message.Body) ?? {};
  } catch {
    // body que não é JSON: mostrado como está, sem evento para reprocessar
  }
  // Registro do destino OnFailure da Lambda: o evento está em requestPayload
  const invocation = body.requestPayload && typeof body.requestPayload === 'object' ? body : null;
  const event = invocation ? invocation.requestPayload : body;
  const attribute = name => message.MessageAttributes?.[name]?.StringValue ?? null;
  const sent = Number(message.Attributes?.SentTimestamp);
  // Sem ApproximateReceiveCount: a própria listagem (ReceiveMessage) o incrementa
  return {
    messageId: message.MessageId,
    sentAt: Number.isFinite(sent) ? new Date(sent).toISOString() : null,
    attempts: invocation?.requestContext?.approximateInvokeCount ?? null,
    source: event.source ?? null,
    detailType: event['detail-type'] ?? null,
    detail: event.detail ?? null,
    errorCode: attribute('ERROR_CODE') ?? invocation?.responsePayload?.errorType ?? invocation?.requestContext?.condition ?? null,
    errorMessage: attribute('ERROR_MESSAGE') ?? invocation?.responsePayload?.errorMessage ?? null,
    ...(!event.source && { body: message.Body })
  };
}
