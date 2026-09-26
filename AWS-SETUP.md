# Configuração AWS do Sistema E-Commerce Distribuído

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

## Fluxo de Deploy

### 1. Deploy dos Recursos AWS

```bash
# Faça o deploy do stack na AWS
./deploy.sh
```

O script irá:
- Empacotar o código com `sam build`
- Fazer o deploy com `sam deploy`
- Criar as tabelas DynamoDB
- Criar as funções Lambda
- Configurar o API Gateway
- Exibir as URLs dos endpoints

### 2. Popular o banco de dados

```bash
# Popule as tabelas com dados iniciais
./seed-env.sh
```

## Estrutura dos Recursos Criados

### API Gateway
- **Health**: `GET /health` - Verifica saúde do sistema
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

### DynamoDB Tables
- **dev-Products**: Dados dos produtos
- **dev-Orders**: Dados dos pedidos
- **dev-Payments**: Dados dos pagamentos
- **dev-Stock**: Controle de estoque
- **dev-StockReservations**: Reservas de estoque

### Funções Lambda
- **HealthFunction**: Verificação de saúde
- **ProductFunction**: Gerenciamento de produtos
- **OrderFunction**: Gerenciamento de pedidos
- **PaymentFunction**: Processamento de pagamentos
- **StockFunction**: Controle de estoque

## Testes

### Testes Unitários
```bash
npm run test:unit
```

### Testes de Integração
```bash
npm run test
```

### Testes Manual
Após o deploy, você pode testar os endpoints:

```bash
# Verificar saúde do sistema
curl $(aws cloudformation describe-stacks --stack-name distributed-ecommerce-system --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" --output text)/health

# Listar produtos
curl $(aws cloudformation describe-stacks --stack-name distributed-ecommerce-system --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" --output text)/products

# Criar pedido
curl -X POST -H "Content-Type: application/json" -d '{"productId": "apple", "quantity": 2}' $(aws cloudformation describe-stacks --stack-name distributed-ecommerce-system --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" --output text)/orders
```

## Arquivos de Configuração

- `template.yaml`: Template SAM com definição de todos os recursos
- `samconfig.toml`: Configuração do deployment SAM
- `deploy.sh`: Script de automação do deployment
- `seed-aws.mjs`: Script de seed da tabela Products
- `seed-env.sh`: Script de verificação e execução do seed

## Custo Estimado

Os recursos são configurados com:
- **DynamoDB**: PAY_PER_REQUEST (custo conforme uso)
- **Lambda**: Gratuito (1 milhão de requisições por mês)
- **API Gateway**: $3.50 por milhão de requisições
- **S3**: $0.023 por GB armazenado

**Custo estimado inicial**: ~$0/mês (dentro do free tier)
**Custo após uso**: ~$0.01 por 1000 requisições

## Logs e Monitoramento

Para ver os logs das funções Lambda:
```bash
# Ver logs de uma função específica
aws logs tail /aws/lambda/ProductFunction --follow
```

Para ver os logs do API Gateway:
```bash
aws logs tail /aws/apigateway/distributed-ecommerce-system --follow
```