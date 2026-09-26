# Arquitetura Híbrida - Saga Orchestrator

## Visão Geral

Este sistema implementa uma arquitetura híbrida para processamento de pedidos com Saga pattern, utilizando AWS Step Functions para orquestração e AWS API Gateway externo para acesso público.

## Componentes

### 1. API Gateway Externa
- **URL**: `https://{api-id}.execute-api.{region}.amazonaws.com/{environment}`
- **Público para**: Clientes e aplicativos externos
- **Endpoints**:
  - `GET /health` - Health check do sistema
  - `GET /products` - Listar produtos
  - `GET /products/{id}` - Buscar produto por ID
  - `POST /products` - Criar novo produto
  - `GET /orders` - Listar pedidos
  - `GET /orders/{id}` - Buscar pedido por ID
  - `POST /orders` - Criar pedido (inicia saga)
  - `POST /orders/{id}/pay` - Processar pagamento
  - `POST /orders/{id}/cancel` - Cancelar pedido
  - `POST /payments/{id}/cancel` - Cancelar pagamento

### 2. Saga Orchestrator (via Step Functions)
- **Função Lambda**: `saga-orchestrator`
- **Orquestrador principal**: AWS Step Functions State Machine
- **Acesso**: Via API Gateway externo (integrado)

### 3. Lambdas dos Serviços (Internas)
Acessíveis SOMENTE via Step Functions, SEM endpoints públicos:

- **OrdersFunction** - Gerenciamento de pedidos
  - `createOrder`
  - `confirmOrder`
  - `cancelOrder`

- **PaymentFunction** - Processamento de pagamentos
  - `processPayment`
  - `refundPayment`

- **StockFunction** - Gerenciamento de estoque
  - `reserveStock`
  - `releaseStock`
  - `adjustStock`

- **ProductFunction** - Gerenciamento de produtos
  - CRUD completo de produtos

## Fluxo de Pedido

### 1. Criar Pedido (inicia saga)
```bash
POST /orders
Content-Type: application/json

{
  "productId": "product-123",
  "quantity": 2
}
```

**Fluxo Interno**:
1. API Gateway → Saga Orchestrator Lambda
2. Saga Orchestrator valida produto
3. Step Functions inicia execução:
   - **Step 1**: Chama OrdersFunction (createOrder)
   - **Step 2**: Chama PaymentFunction (processPayment)
   - **Step 3**: Chama StockFunction (reserveStock)
   - **Step 4**: Chama OrdersFunction (confirmOrder)
4. Step Functions garante atomicidade com retry e compensação automática

**Resposta**:
```json
{
  "sagaId": "saga-1729971200123-abc123",
  "executionArn": "arn:aws:states:us-east-1:123456789012:execution:OrderSagaWorkflow:saga-1729971200123-abc123",
  "status": "RUNNING",
  "orderId": "order-1729971200456",
  "correlationId": "corr-123456"
}
```

### 2. Consultar Status da Saga
```bash
GET /saga/{sagaId}
```

**Resposta**:
```json
{
  "id": "saga-1729971200123-abc123",
  "orderId": "order-1729971200456",
  "status": "COMPLETED",
  "startedAt": "2024-10-26T06:20:00.123Z",
  "stoppedAt": "2024-10-26T06:20:05.456Z"
}
```

## Compensação Automática

Se qualquer step falhar, Step Functions executa compensações em ordem reversa:

```
Se releaseStock falha → cancelOrder → refundPayment
```

### Exemplo de Falha na Etapa de Pagamento

1. **Step Functions detecta falha** em PaymentFunction
2. **Compensação iniciada** automaticamente:
   - **Step 1**: Chama StockFunction (releaseStock)
   - **Step 2**: Chama OrdersFunction (cancelOrder)
   - **Step 3**: Chama PaymentFunction (refundPayment)

### Compensação Manual

```bash
POST /saga/{sagaId}/cancel
```

Inicia compensações imediatas para uma saga pendente.

## Estado do Pedido

O status do pedido é determinado pelo Step Functions:

| Status | Descrição |
|--------|-----------|
| `PENDING` | Pedido criado, esperando processamento |
| `PROCESSING` | Pagamento sendo processado |
| `RESERVING` | Estoque sendo reservado |
| `CONFIRMING` | Pedido sendo confirmado |
| `COMPLETED` | Pedido concluído com sucesso |
| `CANCELLED` | Pedido cancelado (compensado) |
| `FAILED` | Saga falhou (rejeição do pagamento ou estoque insuficiente) |

## Monitoramento

### Step Functions
- **Console AWS**: `stepfunctions.us-east-1.amazonaws.com`
- Visualização do workflow visual
- Tracing distribuído via X-Ray
- Metrics: `ExecutionDuration`, `ExecutionFailed`, `ExecutionSucceeded`

### EventBridge
- **Event Bus**: `OrderEventsBus`
- **Eventos**:
  - `OrderCreated` - Pedido criado
  - `PaymentProcessed` - Pagamento processado
  - `StockReserved` - Estoque reservado
  - `OrderConfirmed` - Pedido confirmado
  - `SagaCompleted` - Saga finalizada
  - `SagaCompensated` - Saga compensada

### CloudWatch
- Logs estruturados por serviço
- Lambda logs com correlationId
- Metrics de performance por serviço

## Security

### IAM Roles
Cada Lambda tem permissões específicas:
- **OrdersFunction**: Acessa tabela `dev-Orders`
- **PaymentFunction**: Acessa tabela `dev-Payments`
- **StockFunction**: Acessa tabelas `dev-Stock` e `dev-StockReservations`
- **SagaOrchestratorFunction**: Acessa tabela `dev-Sagas` + invoca Lambdas internas

### VPC (Planejado)
Lambdas serão configuradas com VPC para comunicação segura, sem exposição externa.

## Testando

### Pré-requisitos
```bash
# Configurar variáveis de ambiente
export AWS_REGION=us-east-1
export ENVIRONMENT=dev
export AWS_ACCOUNT_ID=123456789012

# Configurar credenciais AWS
aws configure
```

### Criar Produto
```bash
curl -X POST https://your-api-id.execute-api.us-east-1.amazonaws.com/dev/products \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Camiseta Premium",
    "price": 49.90,
    "description": "Camiseta de algodão 100%",
    "stock": 100
  }'
```

### Criar Pedido (inicia saga)
```bash
curl -X POST https://your-api-id.execute-api.us-east-1.amazonaws.com/dev/orders \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "product-123456789",
    "quantity": 2
  }'
```

### Consultar Status da Saga
```bash
curl https://your-api-id.execute-api.us-east-1.amazonaws.com/dev/saga/saga-1729971200123-abc123
```

### Listar Pedidos
```bash
curl https://your-api-id.execute-api.us-east-1.amazonaws.com/dev/orders
```

## Deploy

### Stack AWS SAM
```bash
# Build
sam build

# Deploy
sam deploy --guided
```

### Variáveis de Ambiente
```bash
# .env
AWS_REGION=us-east-1
ENVIRONMENT=dev
AWS_ACCOUNT_ID=123456789012
SAGA_STATE_MACHINE_ARN=arn:aws:states:us-east-1:123456789012:stateMachine:OrderSagaWorkflow
EVENT_BUS_NAME=OrderEventsBus
```

## Diferenças Chave vs. Arquitetura Original

### Original (Todos os endpoints públicos)
```yaml
OrdersFunction:
  Events:
    GetOrders: Api -> /orders
    CreateOrder: Api -> /orders
    # ... todos os endpoints públicos
```

### Híbrida (Apenas Saga Orchestrator público)
```yaml
OrdersFunction:
  # SEM Events de API Gateway
  # Acesso apenas via Step Functions
```

## Benefícios da Arquitetura Híbrida

### ✅ Segurança
- Lambdas de serviços (orders, payments, stock, products) SEM endpoints públicos
- Acesso apenas via Step Functions ou comunicação interna

### ✅ Performance
- Chamadas diretas Step Functions → Lambda (menos hops)
- API Gateway apenas para tráfego externo

### ✅ Custo
- API Gateway só para tráfego público
- Lambdas internas não geram custos de API Gateway

### ✅ Manutenibilidade
- Front-end vs back-end bem separados
- Fácil auditar e controlar permissões

### ✅ Observabilidade
- X-Ray tracing completo de todos os serviços
- Step Functions workflow visual
- EventBridge para comunicação assíncrona

## Próximos Passos

1. ✅ Template.yaml com arquitetura híbrida
2. ✅ Step Functions State Machine
3. ✅ StepFunctionsClient
4. ✅ EventPublisher real
5. ⏳ Configurar EventBridge Rules
6. ⏳ Deploy para AWS
7. ⏳ Testes end-to-end
8. ⏳ Implementar VPC para Lambdas internos

## Recursos

- **AWS Step Functions**: https://docs.aws.amazon.com/step-functions/
- **AWS Lambda**: https://docs.aws.amazon.com/lambda/
- **EventBridge**: https://docs.aws.amazon.com/eventbridge/
- **DynamoDB**: https://docs.aws.amazon.com/dynamodb/
