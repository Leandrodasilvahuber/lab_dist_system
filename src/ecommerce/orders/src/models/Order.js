export class Order {
  constructor(data) {
    this.id = data.id;
    this.productId = data.productId;
    this.quantity = data.quantity;
    this.total = data.total;
    this.status = data.status || 'STARTED';
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }

  toDynamo() {
    return {
      id: this.id,
      productId: this.productId,
      quantity: this.quantity,
      total: this.total,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static fromDynamo(item) {
    return new Order({
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      total: item.total,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    });
  }

  canProcessPayment() {
    return this.status === 'STARTED' || this.status === 'ORDER_CREATED';
  }

  canReserveStock() {
    return this.status === 'PAYMENT_APPROVED';
  }

  canConfirm() {
    return this.status === 'STOCK_RESERVED';
  }

  canCancel() {
    return !['COMPLETED', 'CANCELLED'].includes(this.status);
  }

  static getStatusFlow() {
    return {
      STARTED: 'PEDIDO CRIADO',
      ORDER_CREATED: 'PEDIDO CRIADO',
      PAYMENT_PENDING: 'PAGAMENTO PENDENTE',
      PAYMENT_APPROVED: 'PAGAMENTO APROVADO',
      STOCK_PENDING: 'ESTOQUE PENDENTE',
      STOCK_RESERVED: 'ESTOQUE RESERVADO',
      COMPLETED: 'PEDIDO COMPLETO',
      FAILED: 'FALHADO',
      COMPENSATING: 'COMPENSANDO',
      COMPENSATED: 'COMPENSADO',
      CANCELLED: 'CANCELADO'
    };
  }
}