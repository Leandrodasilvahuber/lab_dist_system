export class Payment {
  constructor(data) {
    this.id = data.id;
    this.orderId = data.orderId;
    this.amount = data.amount;
    this.status = data.status || 'PENDING';
    this.method = data.method || 'CREDIT_CARD';
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }

  toDynamo() {
    return {
      id: this.id,
      orderId: this.orderId,
      amount: this.amount,
      status: this.status,
      method: this.method,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static fromDynamo(item) {
    return new Payment({
      id: item.id,
      orderId: item.orderId,
      amount: item.amount,
      status: item.status,
      method: item.method,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    });
  }

  static getStatusFlow() {
    return {
      PENDING: 'PENDENTE',
      APPROVED: 'APROVADO',
      FAILED: 'FALHADO',
      REFUNDED: 'ESTORNADO',
      PARTIALLY_REFUNDED: 'PARCIALMENTE ESTORNADO'
    };
  }
}