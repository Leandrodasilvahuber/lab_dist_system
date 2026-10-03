import { Database } from '../database.mjs';
import { NotFoundError, InvalidStateError, PaymentDeclinedError, ValidationError } from '../errors.mjs';

// Gateway de pagamento simulado: recusa valores acima do limite.
// Permite testar a compensação da saga de forma determinística.
const MAX_APPROVED_AMOUNT = Number(process.env.PAYMENT_MAX_AMOUNT || 10000);

/**
 * SDK Público - Interface uniforme para operações de pagamento
 *
 * Status: approved | declined | refunded
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
      id: id || generateId(),
      orderId,
      amount,
      status: approved ? 'approved' : 'declined',
      correlationId: correlationId || generateCorrelationId(),
      transactionId: generateTransactionId(),
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
    return result;
  }

  /**
   * Buscar pagamento por ID
   */
  async getPayment(paymentId) {
    const payment = await this.db.getItem('payments', { id: paymentId });
    if (!payment) {
      throw new NotFoundError('Payment not found');
    }
    return payment;
  }

  /**
   * Reembolsar pagamento pelo transactionId (API HTTP)
   */
  async refundPayment(transactionId, amount, correlationId) {
    const payment = await this.getPaymentByTransactionId(transactionId);
    if (!payment) {
      throw new NotFoundError('Payment not found');
    }
    return this.refundPaymentById(payment.id, amount, correlationId);
  }

  /**
   * Reembolsar pagamento pelo id (usado pela saga). Reembolsar de novo não é erro.
   */
  async refundPaymentById(paymentId, amount, correlationId) {
    const payment = await this.getPayment(paymentId);
    if (payment.status === 'refunded') {
      return payment;
    }

    const refundAmount = amount ?? payment.amount;
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

  /**
   * Buscar pagamento por transaction ID
   */
  async getPaymentByTransactionId(transactionId) {
    const allPayments = await this.db.scanItems('payments');
    return allPayments.find(p => p.transactionId === transactionId);
  }

  async publish(detailType, detail) {
    if (this.eventBridgeClient) {
      await this.eventBridgeClient.publish({ Source: 'payments', DetailType: detailType, Detail: detail });
    }
  }
}

/**
 * Gerar ID único
 */
function generateId() {
  return `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Gerar ID de transação
 */
function generateTransactionId() {
  return `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Gerar ID de correlação
 */
function generateCorrelationId() {
  return `corr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export default PaymentSDK;
