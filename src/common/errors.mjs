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

/**
 * Dependência indisponível (timeout, erro de infraestrutura, circuit breaker
 * aberto). Não é erro de negócio: vale tentar de novo depois de
 * `retryAfterSeconds` (vira o header Retry-After do 503).
 *
 * `logged`: quem lançou já registrou a falha como error (com contexto, ex.:
 * correlationId); a resposta HTTP não registra de novo, para não contar duas
 * vezes em UnhandledErrors.
 */
export class DependencyUnavailableError extends DomainError {
  constructor(message = 'Service temporarily unavailable', { retryAfterSeconds = 5, cause, logged = false } = {}) {
    super(message, 'ServiceUnavailable', 503);
    this.retryAfterSeconds = retryAfterSeconds;
    this.logged = logged;
    if (cause) this.cause = cause;
  }
}

/**
 * Erro de negócio não muda numa nova tentativa; só falhas de infraestrutura
 * (rede, throttling, timeout, dependência indisponível) valem retry e DLQ.
 */
export function isRetryable(error) {
  return !(error instanceof DomainError) || error instanceof DependencyUnavailableError;
}
