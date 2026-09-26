# Saga Orchestrator Service

This service implements the Saga pattern for distributed transaction management in the e-commerce system. It coordinates the execution of complex business workflows across multiple microservices with proper compensation (rollback) capabilities.

## Overview

The Saga orchestrator manages the complete lifecycle of order processing:

1. **Create Order** - Order service creates the order
2. **Process Payment** - Payment service processes payment
3. **Reserve Stock** - Stock service reserves inventory
4. **Confirm Order** - Order service confirms completion

## Architecture

### Core Components

- **SagaExecutor** - Orchestrates step execution and handles failures
- **CompensationHandler** - Executes compensating transactions in reverse order
- **EventPublisher** - Publishes events and tracks correlations
- **SagaModel** - Manages saga state and step tracking

### Saga States

- `STARTED` - Saga has been initiated
- `EXECUTING` - Steps are being executed
- `FAILED` - A step failed, compensation triggered
- `COMPENSATING` - Compensation steps are running
- `COMPENSATED` - Compensation completed
- `COMPLETED` - Saga completed successfully

### Step States

- `PENDING` - Step waiting to execute
- `EXECUTING` - Step is running
- `COMPLETED` - Step succeeded
- `FAILED` - Step failed
- `COMPENSATING` - Compensation step is running
- `COMPENSATED` - Compensation succeeded

## API Endpoints

### POST /saga/execute
Trigger a new saga execution for order creation.

**Request Body:**
```json
{
  "orderId": "order-123",
  "productId": "product-456",
  "quantity": 2,
  "total": 100
}
```

**Response:**
```json
{
  "sagaId": "saga-1234567890-abc123def",
  "orderId": "order-123",
  "status": "EXECUTING",
  "correlationId": "cor-abc123",
  "stepsCompleted": 0,
  "totalSteps": 4
}
```

### GET /saga/{sagaId}
Get the current status and details of a saga.

**Response:**
```json
{
  "id": "saga-1234567890-abc123def",
  "orderId": "order-123",
  "status": "COMPLETED",
  "steps": [
    {
      "stepName": "createOrder",
      "status": "COMPLETED",
      "startTime": "2025-01-01T10:00:00Z",
      "endTime": "2025-01-01T10:00:05Z"
    },
    {
      "stepName": "processPayment",
      "status": "COMPLETED",
      "startTime": "2025-01-01T10:00:05Z",
      "endTime": "2025-01-01T10:00:10Z"
    }
  ],
  "correlationId": "cor-abc123",
  "createdAt": "2025-01-01T10:00:00Z",
  "updatedAt": "2025-01-01T10:00:15Z"
}
```

### POST /saga/{sagaId}/cancel
Cancel an in-progress saga and trigger compensation.

**Response:**
```json
{
  "sagaId": "saga-1234567890-abc123def",
  "orderId": "order-123",
  "status": "COMPENSATING",
  "correlationId": "cor-abc123"
}
```

### POST /saga/rollback/{orderId}
Manually trigger compensation for an order (useful for debugging).

**Response:**
```json
{
  "sagaId": "saga-1234567890-abc123def",
  "orderId": "order-123",
  "status": "COMPENSATING",
  "correlationId": "cor-abc123",
  "message": "Saga rollback completed"
}
```

### GET /sagas
Get all sagas (useful for debugging and monitoring).

**Response:**
```json
{
  "sagas": [
    {
      "id": "saga-1234567890-abc123def",
      "orderId": "order-123",
      "status": "COMPLETED",
      "steps": [...]
    }
  ],
  "count": 1
}
```

## Saga Flow

### Successful Flow

```
STARTED → EXECUTING → Step 1: Create Order (COMPLETED)
                              ↓
                              Step 2: Process Payment (COMPLETED)
                              ↓
                              Step 3: Reserve Stock (COMPLETED)
                              ↓
                              Step 4: Confirm Order (COMPLETED)
                              ↓
                              COMPLETED
```

### Failed Flow (with Compensation)

```
STARTED → EXECUTING → Step 1: Create Order (COMPLETED)
                              ↓
                              Step 2: Process Payment (FAILED)
                              ↓
                              FAILED → COMPENSATING
                              ↓
                              Step 3 (Reversed): Release Stock (COMPLETED)
                              ↓
                              Step 2 (Reversed): Refund Payment (COMPLETED)
                              ↓
                              Step 1 (Reversed): Cancel Order (COMPLETED)
                              ↓
                              COMPENSATED → COMPLETED
```

## Compensation Actions

When a saga fails, the CompensationHandler executes steps in reverse order:

| Step | Original Action | Compensation Action |
|------|----------------|---------------------|
| Create Order | Create order record | Cancel order |
| Process Payment | Process payment | Refund payment |
| Reserve Stock | Reserve inventory | Release stock |

## Database Schema

### Sagas Table

```json
{
  "id": "saga-1234567890-abc123def",
  "orderId": "order-123",
  "productId": "product-456",
  "status": "EXECUTING",
  "total": 100,
  "steps": [...],
  "correlationId": "cor-abc123",
  "createdAt": "2025-01-01T10:00:00Z",
  "updatedAt": "2025-01-01T10:00:05Z",
  "expiresAt": "2025-02-01T10:00:00Z"
}
```

### Step Structure

```json
{
  "stepName": "createOrder",
  "status": "COMPLETED",
  "compensationAction": "CANCEL_ORDER",
  "retryCount": 0,
  "startTime": "2025-01-01T10:00:00Z",
  "endTime": "2025-01-01T10:00:05Z",
  "errorMessage": null
}
```

## Event Tracking

All saga operations include a `correlationId` for distributed tracing:

1. Saga creation generates correlation ID
2. All service calls include correlation ID
3. All logs include correlation ID
4. All database updates include correlation ID

## Configuration

### Retry Configuration

- **Max Retries**: 3 attempts per step
- **Initial Delay**: 100ms
- **Backoff Factor**: 2 (exponential)
- **Max Delay**: 5000ms

### Compensation Configuration

- **Compensation Delay**: 200ms between steps
- **Compensation Timeout**: 30 seconds
- **Fail on Compensation Failure**: false (partial compensation allowed)

## Testing

### Unit Tests

```bash
# Test saga executor
node test/unit/saga-orchestrator/SagaExecutor.test.mjs

# Test compensation handler
node test/unit/saga-orchestrator/CompensationHandler.test.mjs

# Test saga model
node test/unit/saga-orchestrator/Saga.test.mjs
```

### Integration Tests

```bash
# Test full saga flow
node test/integration/saga-integration.test.mjs
```

### End-to-End Tests

```bash
# Test complete order creation
node test/e2e/order-creation.test.mjs
```

## Best Practices

1. **Always use saga orchestrator** for order processing instead of direct service calls
2. **Monitor saga status** regularly to detect failures early
3. **Handle compensation failures gracefully** - partial compensation is acceptable
4. **Set TTL on saga records** to prevent orphaned records
5. **Use correlationId** for debugging and distributed tracing
6. **Log all saga events** for audit trails and monitoring

## Troubleshooting

### Saga stuck in EXECUTING

- Check service health and logs
- Verify database connectivity
- Check for stuck transactions
- Consider manually triggering compensation

### Compensation failing

- Review individual compensation logs
- Check service compensation methods
- Verify database state
- Ensure idempotency of compensation actions

### High failure rate

- Check service reliability
- Review retry configuration
- Monitor for systemic issues
- Analyze error patterns in logs

## Security Considerations

1. **Authentication**: All API calls should be authenticated (TODO)
2. **Authorization**: Verify user permissions for saga operations (TODO)
3. **Rate Limiting**: Implement rate limiting on saga endpoints (TODO)
4. **Input Validation**: All inputs should be validated before processing

## Future Enhancements

- [ ] Add saga monitoring dashboard
- [ ] Implement saga retry policies per step
- [ ] Add saga timeouts per step
- [ ] Support for long-running sagas with polling
- [ ] Add saga visualization and debugging tools
- [ ] Implement saga event sourcing for audit trails
- [ ] Add saga throttling and circuit breakers
