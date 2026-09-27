# 🛒 Distributed Systems Playground - E-Commerce Module

## Nova Arquitetura: Sistema Distribuído com API Gateway Centralizado e SDKs

### Objetivo

Construir um sistema de e-commerce distribuído escalável e desacoplado com:
- ✅ API Gateway Centralizado (HttpApi)
- ✅ Microservices com SDKs dedicados
- ✅ Saga Orchestrator para transações distribuídas
- ✅ EventBridge para comunicação assíncrona
- ✅ SQS para mensagens com retry
- ✅ Correlation ID para observabilidade distribuída

### Stack

- **Node.js 18x**
- **AWS Lambda** (arm64)
- **API Gateway HttpApi** (centralizado)
- **DynamoDB** (PAY_PER_REQUEST)
- **AWS SAM** (deploy)
- **EventBridge** (comunicação entre serviços)
- **SQS** (mensagens com retry)
- **AWS SDKs** (desacoplamento)

### Estrutura (Arquitetura Modular)

```
src/
├── common/
│   ├── contracts/                      # Contratos TypeScript para interfaces
│   └── sdks/                          # SDKs para comunicação entre serviços
│       ├── ProductSDK.mjs             # SDK do serviço de produtos
│       ├── OrderSDK.mjs              # SDK do serviço de pedidos
│       ├── PaymentSDK.mjs            # SDK do serviço de pagamentos
│       ├── StockSDK.mjs              # SDK do serviço de estoque
│       └── index.mjs                 # Exportação centralizada dos SDKs
│
├── layers/
│   └── api-gateway-layer/             # API Gateway centralizado
│       └── src/
│           ├── routes/
│           │   └── apiRoutes.js      # Roteamento centralizado
│           └── middleware/
│               ├── errorHandler.js    # Tratamento de erros
│               └── authMiddleware.js  # Autenticação (futura)
│               └── response.mjs       # Helpers de response
│
└── ecommerce/
    ├── products/                     # Serviço de produtos
    │   ├── src/
    │   │   ├── index.mjs             # Handler Lambda
    │   │   ├── service.mjs           # Lógica de negócio
    │   │   └── repository.mjs        # Acesso ao DynamoDB
    │   └── test/
    │       └── unit/
    │           └── products.test.mjs # Testes unitários
    │
    ├── orders/                       # Serviço de pedidos
    │   ├── src/
    │   │   ├── index.mjs             # Handler Lambda
    │   │   ├── service.mjs           # Lógica de negócio
    │   │   └── repository.mjs        # Acesso ao DynamoDB
    │   └── test/
    │       └── unit/
    │           └── orders.test.mjs   # Testes unitários
    │
    ├── payments/                     # Serviço de pagamentos
    │   ├── src/
    │   │   ├── index.mjs             # Handler Lambda
    │   │   ├── service.mjs           # Lógica de negócio
    │   │   └── repository.mjs        # Acesso ao DynamoDB
    │   └── test/
    │       └── unit/
    │           └── payments.test.mjs # Testes unitários
    │
    ├── stock/                        # Serviço de estoque
    │   ├── src/
    │   │   ├── index.mjs             # Handler Lambda
    │   │   ├── service.mjs           # Lógica de negócio
    │   │   └── repository.mjs        # Acesso ao DynamoDB
    │   └── test/
    │       └── unit/
    │           └── stock.test.mjs   # Testes unitários
    │
    └── saga-orchestrator/             # Saga Orchestrator
        ├── src/
        │   ├── index.mjs             # Handler principal
        │   ├── SagaExecutor.mjs      # Execução das sagas
        │   ├── CompensationHandler.mjs # Gerenciamento de compensação
        │   ├── SagaModel.mjs        # Modelo de dados
        │   └── EventPublisher.mjs    # Publicação de eventos
        ├── workflow/
        │   ├── order-creation.mjs    # Workflow completo
        │   └── templates/            # Templates de sagas
        └── README.md                 # Documentação completa
│
test/
├── unit/                            # Testes unitários
│   ├── common/
│   │   ├── contracts.test.mjs       # Testes de contratos
│   │   └── sdks.test.mjs           # Testes de SDKs
│   └── ecommerce/
│       ├── orders.test.mjs
│       ├── payments.test.mjs
│       ├── products.test.mjs
│       ├── stock.test.mjs
│       └── saga-orchestrator.test.mjs
└── integration/                     # Testes de integração
    └── e2e/                          # Testes end-to-end
        └── order-creation.test.mjs
```

### API Endpoints (API Gateway Centralizado)

```http
# Health Check
GET  /health

# Products Service
GET    /products                           # Listar todos os produtos
GET    /products/{id}                      # Buscar produto por ID
POST   /products                           # Criar novo produto

# Orders Service  
GET    /orders                             # Listar todos os pedidos
GET    /orders/{id}                        # Buscar pedido por ID
POST   /orders                             # Criar novo pedido
POST   /orders/confirm                      # Confirmar pedido
POST   /orders/cancel                      # Cancelar pedido

# Payments Service
POST   /payments                           # Processar pagamento
POST   /payments/refund                     # Estornar pagamento

# Stock Service
GET    /stock                              # Listar todo o estoque
GET    /stock/{productId}                   # Buscar estoque do produto
POST   /stock/{productId}/reserve          # Reservar estoque
POST   /stock/{productId}/release          # Liberar estoque
POST   /stock/{productId}/adjust           # Ajustar estoque

# Saga Orchestrator
POST   /saga/execute                       # Executar saga completa de compra
GET    /saga/{sagaId}                      # Obter status da saga
POST   /saga/{sagaId}/cancel              # Cancelar saga e acionar compensação
POST   /saga/rollback/{orderId}            # Acionar compensação manual
GET    /sagas                              # Listar todas as sagas
```

### Fluxo da Saga (Event-Driven)

**Fluxo Sucesso:**
```
CLIENTE → API Gateway → Saga Orchestrator
                          ↓
                    1. Create Order
                    2. Process Payment (EventBridge → Payment Service)
                    3. Reserve Stock (EventBridge → Stock Service)
                    4. Confirm Order (EventBridge → Order Service)
                          ↓
                    COMPLETED
```

**Fluxo com Falha e Compensação:**
```
1. Create Order → SUCESSO
2. Process Payment → FALHA
                          ↓
                    Trigger Compensation
                    ↓
3. Release Stock (Reverso) → SUCESSO
4. Refund Payment (Reverso) → SUCESSO
5. Cancel Order (Reverso) → SUCESSO
                          ↓
                    COMPENSATED
```

### Estados da Saga

```text
# Estados Principais
STARTED           → Saga iniciada
EXECUTING        → Passos em execução
COMPLETED        → Saga concluída com sucesso
FAILED           → Saga falhou
COMPENSATING     → Compensação em andamento
COMPENSATED      → Saga compensada
CANCELLED        → Saga cancelada manualmente

# Estados dos Passos
PENDING          → Passo pendente
EXECUTING        → Passo em execução
COMPLETED        → Passo concluído
FAILED           → Passo falhou
COMPENSATING     → Compensação do passo
COMPENSATED      → Compensação concluída
```

### DynamoDB Tables

- **dev-Products** - Dados dos produtos (id, nome, preço, estoque)
- **dev-Orders** - Dados dos pedidos (id, productId, quantity, status, total)
- **dev-Payments** - Dados dos pagamentos (id, orderId, amount, status)
- **dev-Stock** - Controle de estoque (id, productId, available, reserved)
- **dev-StockReservations** - Reservas pendentes (id, productId, quantity, orderId)
- **dev-Sagas** - Estado e rastreamento das sagas (id, orderId, status, steps)

### Como Executar

```bash
# Instalar dependências
npm install

# Rodar testes unitários
npm run test:unit

# Rodar testes de integração
npm run test

# Rodar testes end-to-end
npm run test:e2e

# Rodar todos os testes
npm run test:all
```

### Próximos Passos

1. **Deploy no AWS**:
   ```bash
   # Build do projeto
   npm run build
   
   # Deploy dos recursos
   ./deploy.sh
   
   # Popular dados iniciais
   ./seed-env.sh
   ```

2. **Testes da aplicação**:
   - Testar endpoints via Postman/AWS Console
   - Validar fluxo completo da saga
   - Verificar logs e métricas

3. **Implementar funcionalidades avançadas**:
   - Monitoramento e dashboards
   - Circuit breakers e retries
   - Rate limiting e segurança

4. **Avançar para**:
   - Etapa 02: Chaos Testing
   - Etapa 03: Observabilidade e Monitoring
   - Etapa 04: Scaling e Performance

### Notas Importantes

- ✅ **Arquitetura Modular**: Cada serviço é independente com seu próprio SDK
- ✅ **Comunicação Assíncrona**: EventBridge + SQS para desacoplamento total
- ✅ **Saga Pattern**: Orquestrador completo com compensação automática
- ✅ **Observabilidade**: Correlation ID em todas as requisições
- ✅ **Retry e DLQ**: Mensagens com retry automático e dead-letter queue
- ✅ **Idempotência**: Todos os endpoints suportam requisições idempotentes
- ⚠️ **Pagamento**: Simulado (integrar gateway real em produção)
- 🔄 **Próximo**: Chaos Engineering e observabilidade avançada

### Tecnologias Utilizadas

- **HttpApi**: API Gateway moderno com performance superior
- **Arm64**: Lambda functions otimizadas para custo-performance
- **PAY_PER_REQUEST**: DynamoDB escalável conforme uso
- **EventBridge**: Comunicação entre serviços confiável
- **SQS**: Filas de mensagens com retry automático
- **SAM**: Deploy simplificado e infra-as-code
