# Configuração AWS do Sistema E-Commerce Distribuído

## Arquitetura Moderna

Este sistema implementa uma arquitetura de microservices totalmente desacoplada com:
- **API Gateway HttpApi** centralizado
- **Microservices independentes** com SDKs dedicados
- **EventBridge Rules** para comunicação assíncrona
- **Saga Orchestrator** para transações distribuídas
- **SQS com Dead-letter Queue** para resiliência
- **DynamoDB** com PAY_PER_REQUEST para escalabilidade

## Pré-requisitos

1. **AWS CLI instalado e configurado**
   ```bash
   # Instale AWS CLI (se não tiver)
   # Ubuntu/Debian:
   sudo apt-get install aws-cli
   
   # Configure suas credenciais
   aws configure
   # AWS Access Key ID [None]: SUA_ACCESS_KEY
   # AWS Secret Access Key [None]: SUA_SECRET_KEY
   # Default region name [None]: us-east-1
   # Default output format [None]: json
   ```

2. **SAM CLI instalado**
   ```bash
   # Instale SAM CLI
   sudo apt-get install sam-cli
   ```

3. **Node.js 18+ instalado**
   ```bash
   # Instale Node.js 18+
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   
   # Verifique versão
   node --version  # Deve ser v18.x ou superior
   npm --version
   ```

## Fluxo de Deploy

### 1. Build e Deploy dos Recursos AWS

```bash
# Instalar dependências
npm install

# Build do projeto
npm run build

# Faça o deploy do stack na AWS
./deploy.sh
```

O script irá:
- Empacotar o código com `sam build`
- Fazer o deploy com `sam deploy`
- Criar todas as tabelas DynamoDB
- Criar funções Lambda para cada microservice
- Configurar API Gateway HttpApi centralizado
- Configurar EventBridge Rules para comunicação entre serviços
- Criar SQS Queue com Dead-letter Queue
- Exibir as URLs dos endpoints
- Gerar outputs com todas as referências necessárias

### 2. Popular o banco de dados

```bash
# Popule as tabelas com dados iniciais
./seed-env.sh
```

## Estrutura dos Recursos Criados

### API Gateway Centralizado (HttpApi)
- **Health**: `GET /health` - Verificação de saúde global
- **Products**: 
  - `GET /products` - Lista todos os produtos
  - `GET /products/{id}` - Busca produto por ID
  - `POST /products` - Cria novo produto
- **Orders**:
  - `GET /orders` - Lista todos os pedidos
  - `GET /orders/{id}` - Busca pedido por ID
  - `POST /orders` - Cria novo pedido
  - `POST /orders/confirm` - Confirma pedido
  - `POST /orders/cancel` - Cancela pedido
- **Payments**:
  - `POST /payments` - Processa pagamento
  - `POST /payments/refund` - Estorna pagamento
- **Stock**:
  - `GET /stock` - Lista todo o estoque
  - `GET /stock/{productId}` - Busca estoque do produto
  - `POST /stock/{productId}/reserve` - Reserva estoque
  - `POST /stock/{productId}/release` - Libera estoque
  - `POST /stock/{productId}/adjust` - Ajusta estoque
- **Saga Orchestrator**:
  - `POST /saga/execute` - Executa saga completa de compra
  - `GET /saga/{sagaId}` - Status da saga
  - `POST /saga/{sagaId}/cancel` - Cancela saga
  - `GET /sagas` - Lista todas as sagas

### Microservices Lambda
- **GatewayFunction**: Roteamento centralizado (API Gateway Layer)
- **OrderFunction**: Serviço de pedidos
- **PaymentFunction**: Serviço de pagamentos
- **StockFunction**: Serviço de estoque
- **SagaOrchestratorFunction**: Orquestrador de transações distribuídas

### DynamoDB Tables
- **dev-Products**: Dados dos produtos (id, nome, preço, estoque)
- **dev-Orders**: Dados dos pedidos (id, productId, quantity, status, total)
- **dev-Payments**: Dados dos pagamentos (id, orderId, amount, status)
- **dev-Stock**: Controle de estoque (id, productId, available, reserved)
- **dev-StockReservations**: Reservas pendentes (id, productId, quantity, orderId)
- **dev-Sagas**: Estado das sagas (id, orderId, status, steps, correlationId)

### EventBridge Rules (Comunicação Assíncrona)
- **OrderCreatedRule**: Dispara PaymentFunction quando pedido criado
- **PaymentProcessedRule**: Dispara StockFunction quando pagamento processado
- **StockReservedRule**: Dispara OrderFunction quando estoque reservado
- **OrderConfirmedRule**: Dispara SagaOrchestratorFunction quando pedido confirmado

### SQS Queues
- **OrderEventsQueue**: Fila de eventos de pedidos
- **OrderEventsDlq**: Dead-letter queue para mensagens falhas
- **Configuration**: 5 tentativas de retry, visibilidade 300s, TTL 14 dias

## Testes

### Testes

#### Testes Unitários
```bash
# Testar todos os serviços
npm run test:unit

# Testar serviços específicos
npm run test:unit:orders
npm run test:unit:payments  
npm run test:unit:products
npm run test:unit:stock
npm run test:unit:saga
```

#### Testes de Integração
```bash
npm run test:integration
```

#### Testes End-to-End
```bash
npm run test:e2e
```

#### Testes de Saga
```bash
# Testar fluxo completo da saga
npm run test:saga:complete
npm run test:saga:compensation
```

#### Testes Manual
Após o deploy, você pode testar os endpoints:

```bash
# Verificar saúde do sistema
curl $(aws cloudformation describe-stacks --stack-name distributed-ecommerce-system --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" --output text)/health

# Listar produtos
curl $(aws cloudformation describe-stacks --stack-name distributed-ecommerce-system --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" --output text)/products

# Criar pedido
curl -X POST -H "Content-Type: application/json" -d '{"productId": "apple", "quantity": 2}' $(aws cloudformation describe-stacks --stack-name distributed-ecommerce-system --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" --output text)/orders

# Executar saga completa
curl -X POST -H "Content-Type: application/json" -d '{"productId": "iphone", "quantity": 1, "correlationId": "test-123"}' $(aws cloudformation describe-stacks --stack-name distributed-ecommerce-system --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" --output text)/saga/execute

# Verificar status da saga
curl $(aws cloudformation describe-stacks --stack-name distributed-ecommerce-system --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" --output text)/saga/test-saga-id-123
```

## Arquivos de Configuração

### Infraestrutura
- **`template.yaml`**: Template SAM completo com:
  - API Gateway HttpApi centralizado
  - Funções Lambda para cada microservice
  - EventBridge Rules para comunicação
  - SQS Queue com DLQ
  - DynamoDB Tables com TTL

### Scripts de Deployment
- **`deploy.sh`**: Script principal de deploy (sam build + deploy)
- **`seed-env.sh`**: Script de inicialização de dados
- **`destroy.sh`**: Script para remover todos os recursos

### Configurações
- **`samconfig.toml`**: Configuração do deployment SAM
- **`package.json`**: Dependências e scripts de build/test
- **`.env.example`**: Variáveis de ambiente de exemplo

### SDKs e Contratos
- **`src/common/contracts/`**: Interfaces TypeScript para comunicação
- **`src/common/sdks/`**: SDKs para comunicação entre serviços
- **`src/layers/api-gateway-layer/`**: API Gateway centralizado

### Serviços
- **`src/ecommerce/*/`**: Código fonte de cada microservice
- **`src/ecommerce/saga-orchestrator/`**: Saga Orchestrator completo

## Custo Estimado

### Configuração Atual (Optimizada)

| Serviço | Configuração | Custo Estimado |
|---------|-------------|---------------|
| **DynamoDB** | PAY_PER_REQUEST | ~$0.01/GB-mês |
| **Lambda** | 1M req/mês free tier | ~$0 (até free tier) |
| **API Gateway** | HttpApi + 1M req/mês | ~$3.50/mês |
| **EventBridge** | 1M eventos/mês | ~$1.00/mês |
| **SQS** | 1M mensagens/mês | ~$0.40/mês |
| **S3** | Sam builds | ~$0.023/GB-mês |

**Custo estimado inicial**: ~$4.90/mês (after free tier)
**Custo por 1000 requisições**: ~$0.01

### Recomendações de Otimização

1. **Lambda**: Utiliza arm64 para custo-performance
2. **DynamoDB**: PAY_PER_REQUEST para carga variável
3. **API Gateway**: HttpApi (mais barato que REST)
4. **SQS**: Configurado com DLQ para evitar perdas

## Logs e Monitoramento

### Logs Lambda
```bash
# Ver logs de uma função específica
aws logs tail /aws/lambda/OrderFunction --follow
aws logs tail /aws/lambda/PaymentFunction --follow
aws logs tail /aws/lambda/StockFunction --follow
aws logs tail /aws/lambda/SagaOrchestratorFunction --follow

# Ver logs do Gateway
aws logs tail /aws/lambda/GatewayFunction --follow

# Ver logs de todas as funções
aws logs tail '/aws/lambda/*' --follow
```

### Logs API Gateway
```bash
# Ver logs do HttpApi
aws logs tail /aws/apigateway/distributed-ecommerce-system --follow
```

### Logs EventBridge
```bash
# Ver logs das regras EventBridge
aws logs tail /aws/events/rule/OrderCreatedRule --follow
aws logs tail /aws/events/rule/PaymentProcessedRule --follow
```

### Logs SQS
```bash
# Ver mensagens da fila
aws sqs receive-message --queue-url $(aws cloudformation describe-stacks --stack-name distributed-ecommerce-system --query "Stacks[0].Outputs[?OutputKey=='OrderEventsQueueUrl'].OutputValue" --output text)
```

### Métricas CloudWatch
```bash
# Métricas Lambda
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Invocations --dimensions Name=FunctionName,Value=OrderFunction --start-time $(date -u -d '5 minutes ago' +'%Y-%m-%dT%H:%M:%SZ') --end-time $(date -u -d 'now' +'%Y-%m-%dT%H:%M:%SZ') --period 300 --statistics Sum

# Métricas API Gateway
aws cloudwatch get-metric-statistics --namespace AWS/ApiGateway --metric-name Count --dimensions Name=ApiName,Value=distributed-ecommerce-system --start-time $(date -u -d '5 minutes ago' +'%Y-%m-%dT%H:%M:%SZ') --end-time $(date -u -d 'now' +'%Y-%m-%dT%H:%M:%SZ') --period 300 --statistics Sum

## Arquitetura e Design Patterns

### Principais Padrões Utilizados

1. **Microservices Pattern**: Cada serviço é independente e escalável
2. **Saga Pattern**: Transações distribuídas com compensação automática
3. **Event-Driven Architecture**: Comunicação assíncrona via EventBridge
4. **API Gateway Pattern**: Roteamento centralizado para todos os endpoints
5. **CQRS Pattern**: Separação de leitura/escrita nos serviços

### Melhores Práticas Implementadas

1. **Desacoplamento Total**: Services não dependem uns dos outros
2. **Idempotência**: Todos endpoints suportam requisições duplicadas
3. **Retry Automático**: SQS com exponential backoff
4. **Dead-letter Queue**: Mensagens falhas não são perdidas
5. **Correlation ID**: Rastreamento distribuído
6. **Timeouts**: Configurações de tempo de execução adequadas
7. **Resource-Based Policies**: Permissões mínimas necessárias

### Escalabilidade

1. **Lambda Auto-scaling**: Automaticamente escala com demanda
2. **DynamoDB Auto-scaling**: PAY_PER_REQUEST para carga variável
3. **HttpApi Performance**: Baixa latência e alta concorrência
4. **EventBridge High-throughput**: Milhares de eventos por segundo

### Resiliência

1. **Circuit Breaker**: Implementado no Saga Orchestrator
2. **Bulkhead Pattern**: Isolamento entre services
3. **Retry Policies**: Configuráveis por serviço
4. **Health Checks**: Endpoints de saúde integrados
5. **Graceful Degradation**: Falhas não afetam todo o sistema
```