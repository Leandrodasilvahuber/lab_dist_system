export class Product {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.price = data.price;
    this.description = data.description || '';
    this.stock = data.stock || 0;
    this.reserved = data.reserved || 0;
    this.ordersInProgress = data.ordersInProgress || 0;
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }

  toDynamo() {
    return {
      id: this.id,
      name: this.name,
      price: this.price,
      description: this.description,
      stock: this.stock,
      reserved: this.reserved,
      ordersInProgress: this.ordersInProgress,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static fromDynamo(item) {
    return new Product({
      id: item.id,
      name: item.name,
      price: item.price,
      description: item.description,
      stock: item.stock,
      reserved: item.reserved,
      ordersInProgress: item.ordersInProgress,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    });
  }

  hasAvailableStock(quantity) {
    return (this.stock - this.reserved) >= quantity;
  }

  getAvailableStock() {
    return this.stock - this.reserved;
  }

  getReservedStock() {
    return this.reserved;
  }
}