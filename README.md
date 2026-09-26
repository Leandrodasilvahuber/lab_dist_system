# 🛒 Distributed Systems Playground - E-Commerce Module

## Etapa 01: E-Commerce with Saga Pattern

### Objetivo

Construir um módulo de e-commerce que demonstra:
- ✅ Produto
- ✅ Pedido
- ✅ Pagamento
- ✅ Reserva de estoque
- ✅ Saga (fluxo sequencial com compensação)
- ✅ Correlation ID para observabilidade

### Stack

- Node.js
- AWS Lambda
- API Gateway
- DynamoDB
- AWS SAM

### Estrutura

```
src/
├── functions/
│   └── ecommerce/
│       ├── index.mjs                    # API Gateway routes
│       ├── health.mjs                   # Health check endpoint
│       ├── create-product.mjs           # Create product
│       ├── create-order.mjs             # Create order
│       ├── payment.mjs                  # Process payment
│       ├── reserve-stock.mjs            # Reserve stock
│       ├── confirm-order.mjs            # Confirm order
│       ├── refund-payment.mjs           # Refund payment
│       ├── release-stock.mjs            # Release stock
│       ├── cancel-order.mjs             # Cancel order
│       ├── get-products.mjs             # Get products
│       └── get-order.mjs                # Get orders
│
└── shared/
    ├── database.mjs                     # DynamoDB wrapper
    ├── response.mjs                     # Response helpers
    └── logger.mjs                       # Logging with correlationId

test/
└── mock-request.mjs                     # Test scenarios
```

### API Endpoints

```http
GET  /health

GET  /products
GET  /products/{id}

POST /products

GET  /orders
GET  /orders/{id}
```

### Fluxo da Saga

**Sucesso:**
```
START
  ↓
CREATE ORDER
  ↓
PAYMENT (APPROVED)
  ↓
RESERVE STOCK
  ↓
CONFIRM ORDER
  ↓
COMPLETED
```

**Falha com Compensação:**
```
CREATE ORDER
  ↓
PAYMENT ✅
  ↓
STOCK ❌
  ↓
COMPENSATION
  ├── REFUND PAYMENT
  └── CANCEL ORDER
  ↓
COMPENSATED / CANCELLED
```

### Estados do Pedido

```text
STARTED
ORDER_CREATED
PAYMENT_PENDING
PAYMENT_APPROVED
STOCK_PENDING
STOCK_RESERVED
COMPLETED
FAILED
COMPENSATING
COMPENSATED
CANCELLED
```

### DynamoDB Tables

- `Products` - Armazena informações dos produtos
- `Orders` - Armazena os pedidos
- `Payments` - Armazena os pagamentos
- (opcional) `Sagas` - Para rastreamento da saga completa

### Como Executar

```bash
# Install dependencies
npm install

# Run test scenarios
node test/mock-request.mjs
```

### Próximos Passos

1. Deploy no AWS:
   - Criar tabelas no DynamoDB
   - Deploy via AWS SAM ou upload manual das Lambda functions
   - Configurar API Gateway

2. Testar endpoints via Postman/AWS Console

3. Implementar Saga orchestrator (opcional)

4. Avançar para Etapa 02: Chaos Testing

### Notas Importantes

- Não implementado: Chaos, Ride Simulator, Logistics, EventBridge, SQS, Step Functions, Kafka
- Foco: Ter a Saga funcionando corretamente primeiro
- Pagamento: Simulado (não integra com gateway real)
- Idempotência: Campos de idempotencyKey prontos para uso
- Observabilidade: Correlation ID em todos os logs
