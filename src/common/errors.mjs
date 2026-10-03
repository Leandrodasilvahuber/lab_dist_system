/**
 * Erros de negócio. O `name` vira o tipo do erro na Lambda (errorType),
 * o que permite ao Step Functions distinguir falhas de negócio (não adianta
 * repetir) de falhas transitórias de infraestrutura (vale repetir).
 */
export class DomainError extends Error {
  constructor(message, name, statusCode) {
    super(message);
    this.name = name;
    this.statusCode = statusCode;
  }
}

export class ValidationError extends DomainError {
  constructor(message) { super(message, 'ValidationError', 400); }
}

export class NotFoundError extends DomainError {
  constructor(message) { super(message, 'NotFound', 404); }
}

export class InvalidStateError extends DomainError {
  constructor(message) { super(message, 'InvalidState', 409); }
}

export class InsufficientStockError extends DomainError {
  constructor(message = 'Insufficient stock') { super(message, 'InsufficientStock', 409); }
}

export class PaymentDeclinedError extends DomainError {
  constructor(message = 'Payment declined') { super(message, 'PaymentDeclined', 402); }
}

export class IdempotencyConflictError extends DomainError {
  constructor(message = 'Idempotency key already used with a different request') {
    super(message, 'IdempotencyConflict', 409);
  }
}
