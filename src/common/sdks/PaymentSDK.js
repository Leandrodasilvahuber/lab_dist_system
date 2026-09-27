import { Database } from '../../database.mjs';

/**
 * SDK Público - Interface uniforme para operações de pagamento
 */
export class PaymentSDK {
  constructor(eventBridgeClient) {
    this.eventBridgeClient = eventBridgeClient;
  }

  /**
   * Processar pagamento
   */
  async processPayment(paymentData) {
    const correlationId = paymentData.correlationId || generateCorrelationId();

    const payment = {
      id: generateId(),
      orderId: paymentData.orderId,
      amount: paymentData.amount,
      status: 'pending', // pending, completed, failed, refunded
      correlationId: correlationId,
      transactionId: generateTransactionId(),
      createdAt: new Date().toISOString()
    };

    await Database.put('Payments', payment.id, payment);
    return payment;
  }

  /**
   * Buscar pagamento por ID
   */
  async getPayment(paymentId) {
    const payment = await Database.get('Payments', paymentId);
    if (!payment) {
      throw new Error('Payment not found');
    }
    return payment;
  }

  /**
   * Refundar pagamento
   */
  async refundPayment(transactionId, amount, correlationId) {
    const payment = await this.getPaymentByTransactionId(transactionId);

    if (payment.status === 'refunded') {
      throw new Error('Payment already refunded');
    }

    payment.status = 'refunded';
    payment.refundedAt = new Date().toISOString();
    payment.refundAmount = amount;
    await Database.put('Payments', payment.id, payment);

    // Em produção, publicar evento
    if (this.eventBridgeClient) {
      await this.eventBridgeClient.publish({
        Source: 'payments',
        DetailType: 'PaymentRefunded',
        Detail: JSON.stringify({
          paymentId: payment.id,
          transactionId,
          amount,
          correlationId
        })
      });
    }

    return payment;
  }

  /**
   * Buscar pagamento por transaction ID
   */
  async getPaymentByTransactionId(transactionId) {
    const allPayments = await Database.scan('Payments');
    return allPayments.find(p => p.transactionId === transactionId);
  }
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