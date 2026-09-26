export class Stock {
  constructor(data) {
    this.id = data.id;
    this.productId = data.productId;
    this.quantity = data.quantity || 0;
    this.reserved = data.reserved || 0;
    this.available = data.available || (data.quantity || 0) - (data.reserved || 0);
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }

  toDynamo() {
    return {
      id: this.id,
      productId: this.productId,
      quantity: this.quantity,
      reserved: this.reserved,
      available: this.available,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static fromDynamo(item) {
    return new Stock({
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      reserved: item.reserved,
      available: item.available,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    });
  }

  canReserve(quantity) {
    return this.available >= quantity;
  }

  reserve(quantity) {
    if (!this.canReserve(quantity)) {
      throw new Error(`Insufficient stock. Available: ${this.available}, Required: ${quantity}`);
    }

    this.reserved += quantity;
    this.available = this.quantity - this.reserved;
    this.updatedAt = new Date().toISOString();

    return true;
  }

  release(quantity) {
    if (this.reserved < quantity) {
      throw new Error(`Cannot release ${quantity} items, only ${this.reserved} are reserved`);
    }

    this.reserved -= quantity;
    this.available = this.quantity - this.reserved;
    this.updatedAt = new Date().toISOString();

    return true;
  }

  adjustQuantity(newQuantity) {
    if (newQuantity < this.reserved) {
      throw new Error(`Cannot reduce quantity below reserved stock. Reserved: ${this.reserved}, New: ${newQuantity}`);
    }

    this.quantity = newQuantity;
    this.available = this.quantity - this.reserved;
    this.updatedAt = new Date().toISOString();

    return true;
  }

  static getStatus() {
    return {
      AVAILABLE: 'DISPONÍVEL',
      RESERVED: 'RESERVADO',
      INSUFFICIENT: 'INSUFICIENTE',
      OUT_OF_STOCK: 'SEM ESTOQUE'
    };
  }
}