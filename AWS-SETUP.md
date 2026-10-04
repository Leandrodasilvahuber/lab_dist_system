# Deploy na AWS

## Pré-requisitos

1. **AWS CLI** com credenciais configuradas:
   ```bash
   aws configure          # Access Key, Secret Key, região (us-east-1)
   aws sts get-caller-identity
   ```
2. **AWS SAM CLI**: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
3. **Node.js 22+** (o esbuild usado pelo `sam build` vem das devDependencies)

## Deploy

```bash
npm install
npm run validate     # opcional: sam validate --lint
export ADMIN_API_KEY=$(openssl rand -hex 24)   # guarde: é a chave das rotas de admin
npm run deploy       # scripts/deploy.sh: sam build + sam deploy
```

O `deploy.sh` grava `ADMIN_API_KEY` no SSM Parameter Store como SecureString
(`/dev/ecommerce/admin-api-key`), passando o valor por arquivo temporário, e não
pela linha de comando. O authorizer lê a chave de lá, com cache de 1 minuto.
Nos deploys seguintes `ADMIN_API_KEY` é opcional: sem ela, a chave atual é
mantida. Para trocar a chave sem redeploy:
`aws ssm put-parameter --name /dev/ecommerce/admin-api-key --type SecureString --overwrite --value file://chave.txt`.
A chave antiga ainda é aceita por até ~6 minutos depois da troca: 1 minuto de
cache no authorizer mais os 5 minutos em que o HttpApi guarda a decisão
(`ReauthorizeEvery: 300` no template).
As rotas
`POST /products` e `POST /stock/{id}/adjust` exigem
o header `X-Api-Key` com essa chave. Para restringir o CORS a uma origem, passe
também `AllowedOrigin=https://...` em `--parameter-overrides`.

O `sam deploy` mostra o changeset e pede confirmação antes de criar os recursos
(`confirm_changeset = true` no `samconfig.toml`). O bucket S3 dos artefatos é
criado e gerenciado pelo SAM (`resolve_s3 = true`).

Depois do deploy, popule o catálogo e o estoque (as tabelas já foram criadas pelo stack):

```bash
npm run seed -- --stage dev
```

## Recursos criados

| Recurso | Descrição |
|---|---|
| `ApiGateway` (HttpApi, stage `dev`) | Rotas de cada serviço + `/health` e fallback na GatewayFunction |
| `ProductFunction`, `OrderFunction`, `StockFunction` | Serviços (HTTP + ações/eventos internos) |
| `PaymentFunction` | Só ações da saga (sem rota HTTP) |
| `SagaOrchestratorFunction` | `/saga/execute`, `/saga/{id}`, `/sagas` |
| `AdminAuthorizerFunction` | Authorizer das rotas de admin (`X-Api-Key`) |
| `SagaStateMachine` (`dev-purchase-saga`) | Saga de compra (Step Functions Standard) |
| `GatewayFunction` | `/health` e 404 com a lista de endpoints |
| Tabelas `dev-Products`, `dev-Orders`, `dev-Payments`, `dev-Inventory`, `dev-StockReservations`, `dev-Sagas` | DynamoDB on-demand, uma ou mais por serviço |
| `EventBus` (`dev-ecommerce-events`) | Eventos de domínio dos serviços |
| `ProductEventsToStockRule` | Entrega `ProductCreated`/`ProductDeleted` à `StockFunction` (cria/remove o inventário), com retry e DLQ `ProductEventsDlq` |
| `OrderEventsQueue` + `OrderEventsDlq` | Recebe os eventos `source: orders` (auditoria) |

Cada função recebe só as permissões de que precisa, e cada serviço acessa apenas
as próprias tabelas:

| Função | Tabelas | Outros acessos |
|---|---|---|
| `ProductFunction` | `Products` | publica eventos |
| `OrderFunction` | `Orders` | publica eventos |
| `PaymentFunction` | `Payments` | publica eventos |
| `StockFunction` | `Inventory`, `StockReservations` | publica eventos; recebe `ProductCreated` e `ProductDeleted` (falhas vão para `ProductEventsDlq`) |
| `SagaOrchestratorFunction` | `Sagas` | invoca `ProductFunction` (preço/validação); inicia a state machine |
| `SagaStateMachine` | `Sagas` | invoca as três Lambdas dos passos |

## Testando

```bash
API=$(aws cloudformation describe-stacks --stack-name distributed-ecommerce-system \
  --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" --output text)

curl $API/health
curl $API/products

# Compra com sucesso
curl -X POST $API/saga/execute -H "Idempotency-Key: $(uuidgen)" \
  -d '{"productId": "apple", "quantity": 2}'
curl $API/saga/<sagaId da resposta>

# Listagens (públicas)
curl $API/orders
curl $API/sagas

# Rota de admin
curl -X POST -H "X-Api-Key: $ADMIN_API_KEY" $API/stock/apple/adjust -d '{"delta": 10}'

# Pagamento recusado (produto de 25000 > limite de 10000): saga termina COMPENSATED
curl -X POST $API/saga/execute -d '{"productId": "server", "quantity": 1}'

# Estoque insuficiente: falha antes de cobrar; pedido cancelado
curl -X POST $API/saga/execute -d '{"productId": "apple", "quantity": 999}'
```

No console do Step Functions (máquina `dev-purchase-saga`) dá para ver cada
execução como diagrama: o passo que falhou e as compensações executadas.

## Logs

```bash
sam logs --stack-name distributed-ecommerce-system -n OrderFunction --tail
sam logs --stack-name distributed-ecommerce-system -n SagaOrchestratorFunction --tail
```

Os logs são JSON (um por linha), então dá para filtrar no CloudWatch Logs
Insights, por exemplo por `correlationId`.

## Custo

Para um laboratório, o uso tende a ficar dentro do free tier. Valores de
referência (us-east-1, confira as páginas de preço antes de escalar):

| Serviço | Cobrança | Observação |
|---|---|---|
| Lambda | por requisição + duração | 1M requisições/mês grátis |
| Step Functions Standard | por transição de estado (~US$ 0,025 / 1.000) | 4.000 transições/mês grátis; ~10 por compra |
| API Gateway HttpApi | por requisição | |
| DynamoDB on-demand | por leitura/escrita | |
| EventBridge | por evento publicado | |

## Removendo tudo

```bash
sam delete --stack-name distributed-ecommerce-system
```

Isso apaga as tabelas e os dados junto com o stack.
