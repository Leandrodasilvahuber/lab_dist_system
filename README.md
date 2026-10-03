# 🛒 Distributed Systems Playground - E-Commerce

Laboratório de sistemas distribuídos na AWS: um e-commerce serverless em que a
compra é uma **saga orquestrada pelo AWS Step Functions**, assíncrona e com
compensação automática.

## Stack

- **Node.js 22** em **AWS Lambda** (arm64), empacotado com esbuild
- **API Gateway HttpApi**
- **AWS Step Functions** (Standard) para orquestrar a saga de compra
- **DynamoDB** (on-demand), com transações e escritas condicionais
- **EventBridge** para eventos de domínio e **SQS + DLQ** para auditoria dos eventos de pedidos
- **AWS SAM** para infraestrutura e deploy, **LocalStack** para rodar localmente

## Arquitetura

```
                        ┌──────────────────────── API Gateway (HttpApi) ─────────────────────────┐
                        │ /products  /orders             /stock      /saga/*  /sagas    /health  │
                        └─────┬─────────┬──────────────────┬────────────┬──────────────────┬─────┘
                              ▼         ▼                  ▼            ▼                  ▼
                          Products   Orders   Payments   Stock    SagaOrchestrator     Gateway
                           Lambda    Lambda    Lambda    Lambda       Lambda            Lambda
                                             (sem HTTP)
                                       ▲         ▲         ▲            │ StartExecution
                                       │  invoca │ ações   │            ▼
                                       └─────────┴─────────┴──── Step Functions ──▶ tabela Sagas
                                                                 (saga de compra)    (progresso)

  Comunicação entre serviços (ninguém lê a tabela de outro):
    SagaOrchestrator ──getProduct (Lambda invoke, síncrono)──▶ Products   preço + 404 imediato
    Products ──ProductCreated (EventBridge, assíncrono)──▶ Stock          cria o inventário inicial

  Tabelas por serviço: Products │ Orders │ Payments │ Inventory + StockReservations │ Sagas
  Cada serviço publica eventos de domínio (OrderCreated, PaymentRefunded...) no EventBridge.
```

- **Serviços** (`src/ecommerce/*`): cada Lambda atende as próprias rotas HTTP e
  também as **ações** invocadas pela saga (`{ action, input }`).
- **SDKs** (`src/common/sdks`): toda a lógica de negócio e acesso ao DynamoDB.
  As operações usadas pela saga são **idempotentes**, então o Step Functions pode
  repeti-las com segurança.
- **Saga** (`src/ecommerce/saga-orchestrator`): inicia a execução e expõe o
  andamento. Os passos e a compensação estão em
  [`workflow/saga-workflow.asl.json`](src/ecommerce/saga-orchestrator/workflow/saga-workflow.asl.json).
  Detalhes em [src/ecommerce/saga-orchestrator/README.md](src/ecommerce/saga-orchestrator/README.md).
- **Dados por serviço**: cada serviço lê e escreve só as próprias tabelas
  (Products → `Products`; Orders → `Orders`; Payments → `Payments`;
  Stock → `Inventory` e `StockReservations`; Saga → `Sagas`). Quando precisa de
  dado de outro serviço, pergunta a ele ou recebe um evento:
  - a saga consulta o produto na Lambda de Products ao iniciar (404 imediato se
    não existir) e envia o preço congelado (`unitPrice`) ao `CreateOrder`;
  - o Stock cria o inventário ao receber `ProductCreated` (regra do EventBridge;
    localmente, entrega em processo). Pedidos só são criados pela saga.

## A saga de compra

```
CreateOrder ──▶ ProcessPayment ──▶ ReserveStock ──▶ ConfirmOrder ──▶ COMPLETED
     │                │                  │                 │
     ▼ falha          ▼ falha            ▼ falha           ▼ falha
  FAILED          CancelOrder      RefundPayment     ReleaseStock
                                    CancelOrder       RefundPayment
                                                       CancelOrder ──▶ COMPENSATED
```

Somente os passos que já foram concluídos são compensados, em ordem reversa.
Falhas transitórias (throttling, conflito de transação, erro da Lambda) são
repetidas com backoff; erros de negócio (`InsufficientStock`, `PaymentDeclined`)
vão direto para a compensação.

```bash
# 1. Inicia a compra: responde na hora com 202
curl -X POST $API/saga/execute \
  -H 'Idempotency-Key: checkout-123' \
  -d '{"productId": "apple", "quantity": 2}'
# {"sagaId":"saga_checkout-123","orderId":"order_saga_checkout-123","status":"RUNNING","statusUrl":"/saga/saga_checkout-123"}

# 2. Acompanha o andamento
curl $API/saga/saga_checkout-123
# {"status":"COMPLETED","steps":{"createOrder":{"status":"COMPLETED",...},...},"progress":{"completed":4,"total":4}}
```

O header `Idempotency-Key` (opcional) evita compras duplicadas: repetir a
requisição com a mesma chave devolve a saga existente (200) em vez de criar outra.

**Status da saga:** `RUNNING` → `COMPLETED` | `COMPENSATING` → `COMPENSATED` |
`FAILED` (falhou no primeiro passo) | `COMPENSATION_FAILED` (exige intervenção manual).

## API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/products` | Lista produtos (`?name=&priceMin=&priceMax=`) |
| POST | `/products` | Cria produto `{ name, price, description?, stock? }` (`stock` vira o estoque inicial no serviço de Stock) |
| GET | `/products/{id}` | Busca produto |
| GET | `/orders` | Lista pedidos (`?status=&productId=`) |
| GET | `/orders/{id}` | Busca pedido |
| GET | `/stock` | Estoque de todos os produtos |
| GET | `/stock/{productId}` | Estoque de um produto (disponível e reservado) |
| POST | `/stock/{productId}/adjust` | Ajusta o estoque `{ delta, name? }` (delta positivo cria o inventário se não existir) |
| **POST** | **`/saga/execute`** | **Inicia uma compra** `{ productId, quantity }` → 202 |
| GET | `/saga/{sagaId}` | Andamento de uma compra |
| GET | `/sagas` | Lista as compras (`?status=`) |

### Exposição

- **Só o API Gateway é público.** Nenhuma Lambda tem Function URL; elas recebem
  HTTP apenas pelas rotas acima.
- **Invocações internas** (exigem permissão IAM, inacessíveis pela internet):
  Step Functions → Orders/Payments/Stock (`{ action, input }`), Saga → Products
  (`getProduct`), EventBridge → Stock (`ProductCreated`) e → SQS. Um request HTTP
  nunca dispara uma ação: `isActionInvocation` exige ausência de `requestContext`.
- **O dashboard usa só** `/health`, `GET/POST /products`, `GET /stock`,
  `GET /orders`, `POST /saga/execute`, `GET /saga/{id}` e `GET /sagas`.
- **Confirmar/cancelar pedido, pagar/reembolsar e reservar/liberar estoque não têm
  rota HTTP**: só a saga executa essas operações, por dentro. Payments não tem
  nenhuma rota pública.
- ⚠️ **A API não tem autenticação.** A única escrita operacional pública é
  `POST /stock/{id}/adjust` (reposição de estoque); antes de expor de verdade,
  proteja-a com um authorizer (JWT/IAM).

Erros de negócio: `400` validação, `402` pagamento recusado, `404` não
encontrado, `409` estado inválido ou estoque insuficiente.

**Estoque:** a quantidade disponível fica na tabela `Inventory`, do serviço de
Stock (o catálogo de Products não guarda estoque). Cada reserva
debita o estoque na mesma transação do DynamoDB em que é registrada, então várias
reservas do mesmo produto podem coexistir sem risco de vender além do disponível,
mesmo com compras simultâneas.

**Pagamento:** o gateway de pagamento é simulado e recusa valores acima de
`PAYMENT_MAX_AMOUNT` (padrão 10000). O produto `server` do seed custa 25000 e
serve para ver a compensação acontecer.

## Estrutura

```
src/
├── common/
│   ├── database.mjs        # DynamoDB (nomes de tabela via env, transações)
│   ├── errors.mjs          # Erros de negócio (viram errorType na Lambda)
│   ├── event-bus.mjs       # Eventos de domínio no EventBridge (ou assinantes locais)
│   ├── http-event.mjs      # Normaliza eventos do HttpApi (payload 2.0)
│   ├── actions.mjs         # Despacho de ações ({ action, input }) e eventos do EventBridge
│   ├── response.mjs        # Respostas HTTP
│   ├── logger.mjs          # Logs JSON (LOG_LEVEL = info | error | silent)
│   └── sdks/               # ProductSDK, OrderSDK, PaymentSDK, StockSDK
├── ecommerce/
│   ├── products/ orders/ payments/ stock/
│   │   ├── index.mjs       # Handler: HTTP, ação ou evento de domínio
│   │   └── src/            # routes, controllers, actions
│   └── saga-orchestrator/
│       ├── index.mjs
│       ├── src/            # routes, controller, SagaService, ProductClient, StepFunctionsClient
│       └── workflow/saga-workflow.asl.json   # gerado por scripts/generate-saga-workflow.py
└── layers/api-gateway-layer/   # /health e fallback 404

scripts/       # seed, deploy, LocalStack, teste e2e, gerador do workflow
test/
├── unit/          # sem infraestrutura
└── integration/   # SDKs contra DynamoDB (LocalStack)
template.yaml  # infraestrutura (SAM)
```

## Comandos

```bash
npm install

npm test                  # testes unitários
npm run lint
npm run validate          # valida o template (sam validate --lint)
npm run build             # empacota as Lambdas (sam build + esbuild)

# Local (LocalStack): veja README-LOCALSTACK.md
npm run localstack:start
npm run seed:local
npm run localstack:deploy # publica Lambdas e saga no LocalStack (para o dashboard)
npm run local-server      # dashboard em http://localhost:3001
npm run test:integration  # SDKs contra o DynamoDB do LocalStack
npm run test:e2e          # saga completa: Lambda + Step Functions + DynamoDB

# AWS: veja AWS-SETUP.md
npm run deploy
npm run seed -- --stage dev
```

O workflow é gerado a partir de `scripts/generate-saga-workflow.py`; depois de
alterar o fluxo, rode `npm run generate:workflow`.

## Dashboard

`ecommerce-dashboard.html`, servido pelo `local-server.mjs`, permite comprar e
acompanhar cada saga em tempo real: os passos concluídos, o que falhou e as
compensações executadas.

O `local-server.mjs` funciona como um API Gateway local: monta o mesmo evento
que o HttpApi envia e chama os handlers reais dos serviços, com o DynamoDB e a
state machine no LocalStack. É o mesmo código que vai para a AWS.

```bash
npm run localstack:start
npm run seed:local
npm run build && npm run localstack:deploy   # publica as Lambdas e a saga no LocalStack
npm run local-server                         # abra http://localhost:3001
```

Para usar o dashboard com a API publicada na AWS, abra
`http://localhost:3001/?api=<ApiGatewayUrl>`.

## Limitações conhecidas

- Eventos de domínio são publicados depois da escrita no banco, sem *outbox*
  transacional: se a publicação falhar, o evento se perde (fica registrado no log).
  Para `ProductCreated` isso deixa o produto sem inventário; recupere com
  `POST /stock/{id}/adjust { delta, name }`.
- O inventário é criado de forma assíncrona: logo após `POST /products`, o estoque
  pode levar um instante para aparecer em `/stock` (consistência eventual).
- A saga depende de forma síncrona do serviço de Products ao iniciar a compra.
- Listagens usam `Scan` (adequado para o laboratório, não para volume grande).
- Não há autenticação na API.
