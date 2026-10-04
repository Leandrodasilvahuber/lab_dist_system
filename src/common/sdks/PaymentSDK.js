import { Database } from '../database.mjs';
import { NotFoundError, InvalidStateError, PaymentDeclinedError, ValidationError } from '../errors.mjs';
import { generateId } from '../ids.mjs';

// Leitura logo depois de uma escrita (retry de um passo, passo seguinte da
// saga): a leitura eventualmente consistente poderia não ver o item gravado
const CONSISTENT = { consistentRead: true };

// Gateway de pagamento simulado: recusa valores acima do limite.
// Permite testar a compensação da saga de forma determinística.
const MAX_APPROVED_AMOUNT = Number(process.env.PAYMENT_MAX_AMOUNT || 10000);

/**
 * SDK Público - Interface uniforme para operações de pagamento
 *
 * Status: approved | declined | refunded | voided
 * `voided` marca um pagamento que a saga anulou antes de ele ser gravado
 * (compensação de um ProcessPayment que falhou sem resposta).
 */
export class PaymentSDK {
  constructor(eventBridgeClient, db = new Database()) {
    this.eventBridgeClient = eventBridgeClient;
    this.db = db;
  }

  /**
   * Processar pagamento
   * `id` opcional torna a operação idempotente (a saga usa um id derivado do sagaId).
   */
  async processPayment({ orderId, amount, correlationId, id }) {
    if (!orderId || typeof amount !== 'number' || !(amount > 0)) {
      throw new ValidationError('orderId and a positive amount are required');
    }

    const approved = amount <= MAX_APPROVED_AMOUNT;
    const payment = {
      id: id || generateId('pay'),
      orderId,
      amount,
      status: approved ? 'approved' : 'declined',
      correlationId: correlationId || generateId('corr'),
      transactionId: generateId('txn'),
      createdAt: new Date().toISOString(),
      ...(!approved && { declineReason: `Amount exceeds limit of ${MAX_APPROVED_AMOUNT}` })
    };

    const created = await this.db.putItemIfNotExists('payments', payment);
    const result = created ? payment : await this.getPayment(payment.id);

    if (created) {
      await this.publish(approved ? 'PaymentProcessed' : 'PaymentDeclined', {
        paymentId: result.id,
        orderId,
        amount,
        correlationId: result.correlationId
      });
    }

    if (result.status === 'declined') {
      throw new PaymentDeclinedError(`Payment declined: ${result.declineReason}`);
    }
    if (result.status === 'voided') {
      throw new InvalidStateError('Payment was voided by the saga compensation');
    }
    return result;
  }

  /**
   * Buscar pagamento por ID (só a saga consulta, logo depois de gravar)
   */
  async getPayment(paymentId) {
    const payment = await this.db.getItem('payments', { id: paymentId }, CONSISTENT);
    if (!payment) {
      throw new NotFoundError('Payment not found');
    }
    return payment;
  }

  /**
   * Reembolsar pagamento pelo id (compensação da saga). Idempotente:
   *  - já reembolsado, recusado ou anulado: nada a fazer;
   *  - inexistente: grava um registro `voided`, para que um ProcessPayment
   *    atrasado com o mesmo id não cobre depois da compensação.
   */
  async refundPaymentById(paymentId, amount, correlationId) {
    const payment = await this.db.getItem('payments', { id: paymentId }, CONSISTENT);

    if (!payment) {
      const voided = { id: paymentId, status: 'voided', voidedAt: new Date().toISOString(), correlationId };
      if (await this.db.putItemIfNotExists('payments', voided)) {
        return voided;
      }
      // O pagamento foi gravado entre a leitura e a anulação: reembolsa normalmente
      return this.refundPaymentById(paymentId, amount, correlationId);
    }

    if (payment.status !== 'approved') {
      return payment;
    }

    const refundAmount = amount ?? payment.amount;
    if (typeof refundAmount !== 'number' || !(refundAmount > 0) || refundAmount > payment.amount) {
      throw new ValidationError(`Refund amount must be between 0 and ${payment.amount}`);
    }

    try {
      const refunded = await this.db.updateItem(
        'payments',
        { id: paymentId },
        'SET #status = :refunded, refundedAt = :now, refundAmount = :amount',
        { ':refunded': 'refunded', ':approved': 'approved', ':now': new Date().toISOString(), ':amount': refundAmount },
        {
          conditionExpression: '#status = :approved',
          expressionAttributeNames: { '#status': 'status' },
          returnValues: 'ALL_NEW'
        }
      );

      await this.publish('PaymentRefunded', {
        paymentId,
        transactionId: payment.transactionId,
        amount: refundAmount,
        correlationId: correlationId || payment.correlationId
      });

      return refunded;
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;

      const current = await this.getPayment(paymentId);
      if (current.status === 'refunded') return current;
      throw new InvalidStateError(`Cannot refund payment in status ${current.status}`);
    }
  }

  async publish(detailType, detail) {
    if (this.eventBridgeClient) {
      await this.eventBridgeClient.publish({ Source: 'payments', DetailType: detailType, Detail: detail });
    }
  }
}

export default PaymentSDK;
