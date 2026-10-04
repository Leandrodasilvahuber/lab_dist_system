import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DlqClient } from '../../../src/layers/api-gateway-layer/src/services/DlqClient.js';
import { createAPIHandler } from '../../../src/layers/api-gateway-layer/src/routes/apiRoutes.js';

process.env.LOG_LEVEL = 'silent';

const QUEUE = 'http://sqs/000/dev-ProductEventsDlq';

function message(id, sentAt, detail = { productId: id, name: `Produto ${id}`, initialStock: 5 }) {
  return {
    MessageId: id,
    ReceiptHandle: `rh-${id}`,
    Body: JSON.stringify({ source: 'products', 'detail-type': 'ProductCreated', detail }),
    Attributes: { SentTimestamp: String(Date.parse(sentAt)), ApproximateReceiveCount: '2' },
    MessageAttributes: { ERROR_MESSAGE: { StringValue: 'Lambda timed out' }, ERROR_CODE: { StringValue: 'SDK_CLIENT_ERROR' } }
  };
}

// Imita o SQS: cada ReceiveMessage devolve as mensagens visíveis; Delete remove
function fakeSqs(messages) {
  const queue = [...messages];
  const calls = [];
  return {
    calls,
    queue,
    async send(command) {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });
      if (name === 'GetQueueAttributesCommand') return { Attributes: { ApproximateNumberOfMessages: String(queue.length) } };
      if (name === 'ReceiveMessageCommand') return { Messages: queue.slice(0, command.input.MaxNumberOfMessages) };
      if (name === 'DeleteMessageCommand') {
        queue.splice(queue.findIndex(m => m.ReceiptHandle === command.input.ReceiptHandle), 1);
        return {};
      }
      return {};
    }
  };
}

const fakeBus = (fail = false) => ({
  published: [],
  async publish(event, options) {
    if (fail) throw new Error('PutEvents failed');
    this.published.push({ event, options });
  }
});

describe('DlqClient', () => {
  it('lista sem repetir, mapeia body e atributos, mais antigas primeiro', async () => {
    const sqs = fakeSqs([message('b', '2026-10-04T11:00:00Z'), message('a', '2026-10-04T10:00:00Z')]);
    const result = await new DlqClient({ queueUrl: QUEUE, client: sqs }).listMessages();

    assert.strictEqual(result.approximateTotal, 2);
    assert.deepStrictEqual(result.messages.map(m => m.messageId), ['a', 'b']);
    assert.deepStrictEqual(result.messages[0], {
      messageId: 'a', sentAt: '2026-10-04T10:00:00.000Z', attempts: null, source: 'products', detailType: 'ProductCreated',
      detail: { productId: 'a', name: 'Produto a', initialStock: 5 }, errorCode: 'SDK_CLIENT_ERROR', errorMessage: 'Lambda timed out'
    });
    // Espiar não esconde as mensagens
    assert.ok(sqs.calls.filter(c => c.name === 'ReceiveMessageCommand').every(c => c.input.VisibilityTimeout === 0));
  });

  it('entende o registro do destino OnFailure da Lambda e reprocessa o evento de dentro dele', async () => {
    const event = { source: 'products', 'detail-type': 'ProductDeleted', detail: { productId: 'p9' } };
    const record = {
      MessageId: 'l1',
      ReceiptHandle: 'rh-l1',
      Body: JSON.stringify({
        version: '1.0',
        requestContext: { condition: 'RetriesExhausted', approximateInvokeCount: 3 },
        requestPayload: event,
        responsePayload: { errorType: 'ProvisionedThroughputExceededException', errorMessage: 'Rate exceeded' }
      }),
      Attributes: { SentTimestamp: String(Date.parse('2026-10-04T12:00:00Z')) }
    };
    const sqs = fakeSqs([record]);
    const bus = fakeBus();
    const client = new DlqClient({ queueUrl: QUEUE, client: sqs, eventBus: bus });

    const [entry] = (await client.listMessages()).messages;
    assert.deepStrictEqual(entry, {
      messageId: 'l1', sentAt: '2026-10-04T12:00:00.000Z', attempts: 3, source: 'products', detailType: 'ProductDeleted',
      detail: { productId: 'p9' }, errorCode: 'ProvisionedThroughputExceededException', errorMessage: 'Rate exceeded'
    });

    await client.redrive('l1');
    assert.deepStrictEqual(bus.published[0].event, { Source: 'products', DetailType: 'ProductDeleted', Detail: { productId: 'p9' } });
    assert.strictEqual(sqs.queue.length, 0);
  });

  it('fila local inexistente: lista vazia', async () => {
    const client = { send: async () => { const e = new Error('nope'); e.name = 'QueueDoesNotExist'; throw e; } };
    const result = await new DlqClient({ queueName: 'local-ProductEventsDlq', client }).listMessages();
    assert.deepStrictEqual(result, { queue: 'local-ProductEventsDlq', approximateTotal: 0, messages: [] });
  });

  it('redrive republica o evento original e só depois apaga; as outras voltam a ficar visíveis', async () => {
    const sqs = fakeSqs([message('a', '2026-10-04T10:00:00Z'), message('b', '2026-10-04T11:00:00Z')]);
    const bus = fakeBus();
    await new DlqClient({ queueUrl: QUEUE, client: sqs, eventBus: bus }).redrive('b');

    assert.deepStrictEqual(bus.published, [{
      event: { Source: 'products', DetailType: 'ProductCreated', Detail: { productId: 'b', name: 'Produto b', initialStock: 5 } },
      options: { required: true, strictLocalDelivery: true }
    }]);
    assert.deepStrictEqual(sqs.queue.map(m => m.MessageId), ['a']);
    const released = sqs.calls.filter(c => c.name === 'ChangeMessageVisibilityCommand').map(c => c.input.ReceiptHandle);
    assert.deepStrictEqual(released, ['rh-a']);
  });

  it('republicação que falha não apaga a mensagem', async () => {
    const sqs = fakeSqs([message('a', '2026-10-04T10:00:00Z')]);
    await assert.rejects(new DlqClient({ queueUrl: QUEUE, client: sqs, eventBus: fakeBus(true) }).redrive('a'), /PutEvents failed/);
    assert.strictEqual(sqs.queue.length, 1);
    assert.ok(!sqs.calls.some(c => c.name === 'DeleteMessageCommand'));
  });

  it('discard apaga sem republicar; id inexistente vira NotFound', async () => {
    const sqs = fakeSqs([message('a', '2026-10-04T10:00:00Z')]);
    const bus = fakeBus();
    const client = new DlqClient({ queueUrl: QUEUE, client: sqs, eventBus: bus });
    await client.discard('a');
    assert.strictEqual(sqs.queue.length, 0);
    assert.strictEqual(bus.published.length, 0);
    await assert.rejects(client.discard('x'), { name: 'NotFound' });
  });
});

describe('rotas /dlq', () => {
  const req = (method, path) => ({ requestContext: { http: { method } }, rawPath: path, headers: {} });

  it('GET /dlq, POST redrive e discard', async () => {
    const done = [];
    const dlq = {
      listMessages: async () => ({ queue: 'q', approximateTotal: 0, messages: [] }),
      redrive: async id => { done.push(['redrive', id]); return { source: 'products', detailType: 'ProductCreated', detail: {} }; },
      discard: async id => { done.push(['discard', id]); return { source: 'products', detailType: 'ProductCreated', detail: {} }; }
    };
    const handler = createAPIHandler({ dlq });
    assert.strictEqual((await handler(req('GET', '/dlq'))).statusCode, 200);
    assert.deepStrictEqual(JSON.parse((await handler(req('POST', '/dlq/m1/redrive'))).body), { redriven: 'm1' });
    assert.deepStrictEqual(JSON.parse((await handler(req('POST', '/dlq/m2/discard'))).body), { discarded: 'm2' });
    assert.deepStrictEqual(done, [['redrive', 'm1'], ['discard', 'm2']]);
  });

  it('mensagem inexistente responde 404; SQS indisponível responde 503', async () => {
    const { NotFoundError } = await import('../../../src/common/errors.mjs');
    const handler = createAPIHandler({ dlq: {
      redrive: async () => { throw new NotFoundError('DLQ message not found'); },
      listMessages: async () => { throw new Error('AccessDenied'); }
    } });
    assert.strictEqual((await handler(req('POST', '/dlq/x/redrive'))).statusCode, 404);
    assert.strictEqual((await handler(req('GET', '/dlq'))).statusCode, 503);
  });
});
