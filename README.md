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
CreateOrder ─▶ ReserveStock ─▶ ProcessPayment ─▶ CommitReservation ─▶ ConfirmOrder ─▶ COMPLETED
     │              │                │                  │                   │
     ▼ falha        ▼ falha          ▼ falha            ▼ falha             ▼ falha
 CancelOrder    ReleaseStock     RefundPayment ◀────────┴───────────────────┘
     │          CancelOrder      ReleaseStock
     ▼               │           CancelOrder
  FAILED             └──────────────┴──▶ COMPENSATED
```

O estoque é reservado **antes** da cobrança: falta de estoque (a falha mais
comum) não gera cobrança seguida de reembolso. `CommitReservation` dá baixa na
reserva (`active` → `committed`) quando a compra está paga.

A compensação começa **no próprio passo que falhou** e segue em ordem reversa.
Uma falha vista pelo Step Functions (timeout, erro de rede) não garante que o
passo não gravou nada; por isso as compensações são idempotentes e tratam
"nunca foi gravado" como nada a desfazer, gravando um registro anulado
(`voided`/`released`) que barra uma escrita atrasada com o mesmo id.

Falhas transitórias (throttling, conflito de transação, timeout ou erro da
Lambda) são repetidas com backoff; erros de negócio (`InsufficientStock`,
`PaymentDeclined`) vão direto para a compensação.

```bash
# 1. Inicia a compra: responde na hora com 202
curl -X POST $API/saga/execute \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"productId": "apple", "quantity": 2}'
# {"sagaId":"saga_3c1f...","orderId":"order_saga_3c1f...","status":"RUNNING","statusUrl":"/saga/saga_3c1f..."}

# 2. Acompanha o andamento (statusUrl da resposta)
curl $API/saga/saga_3c1f...
# {"status":"COMPLETED","steps":{"createOrder":{"status":"COMPLETED",...},...},"progress":{"completed":5,"total":5}}
```

O header `Idempotency-Key` é obrigatório (`400` sem ele; **mudança incompatível**:
clientes que não o enviavam precisam passar a gerar um UUID por compra) e evita compras duplicadas: repetir a
requisição com a mesma chave e o mesmo pedido devolve a saga existente (200) em
vez de criar outra. A mesma chave com outro pedido responde `409`. Se a saga
falhou ao iniciar (Step Functions indisponível), repetir com a mesma chave a
inicia de novo. Se uma dependência estiver fora do ar (serviço de Products,
Step Functions), a resposta é `503` com `Retry-After`: repita com a mesma chave
depois desse tempo. O `sagaId` é `saga_` + hash SHA-256 da chave. A chave precisa
ter de 16 a 255 caracteres (`400` fora disso): use um UUID por compra, porque
quem conhece a chave consegue calcular o `sagaId` e consultar `GET /saga/{id}`.

**Status da saga:** `RUNNING` → `COMPLETED` | `COMPENSATING` → `COMPENSATED` |
`FAILED` (falhou no primeiro passo) | `COMPENSATION_FAILED` (alguma compensação
falhou mesmo após as tentativas; as demais rodaram mesmo assim. Exige intervenção manual).
Os erros de cada execução ficam no log group da state machine (output
`SagaStateMachineLogGroup`) e o trace no X-Ray.

## Observabilidade

Cada Lambda escreve uma linha JSON por evento (`src/common/logger.mjs`) no
`ServicesLogGroup`. As métricas saem nessas mesmas linhas, no
[Embedded Metric Format](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html):
o CloudWatch extrai o bloco `_aws` sozinho, sem `PutMetricData` e sem permissão
IAM nas Lambdas. Namespace `Ecommerce/<ambiente>`:

| Métrica | Dimensões | Origem |
|---|---|---|
| `BusinessErrors` | total, `ErrorType` | toda linha `warn` (erro de negócio: `PaymentDeclined`, `InsufficientStock`, `HTTP_400`...) |
| `UnhandledErrors` | total, `ErrorType` | toda linha `error` (alarme `unhandled-errors`) |
| `ActionCount`, `ActionDuration` (ms) | `Action`+`Outcome` (`ok`/`rejected`/`failed`) | cada ação da saga e evento de domínio (`src/common/actions.mjs`) |

Linhas abaixo do `LOG_LEVEL` não somem das métricas: sai uma linha mínima, sem
`status`, só com os campos EMF. Os alarmes `unhandled-errors` e
`business-errors` (≥ 20 em 5 min) usam essas métricas.

No dashboard: 📊 **Métricas** (séries por tipo de erro e tabela por ação),
📜 **Logs** (warn/error), 🔎 **Rastreio** (estado da saga + todas as linhas
do mesmo `correlationId`, de todos os serviços), ⏱️ **Desempenho** (últimas 10
compras em detalhe), 🎯 **SLOs** (p95 da compra < 2 s, ≥ 99,5% das sagas em
Completed/Compensated, nenhuma mensagem na DLQ há mais de 24 h) e
🩺 **Monitoramento** (alarmes).

## API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/alarms` | Alarmes do CloudWatch do ambiente (aba Monitoramento) |
| GET | `/logs?level=warn\|error&hours=24` | Linhas de log warn/error, mais recentes primeiro (aba Logs) |
| GET | `/trace/{correlationId}` | Todas as linhas de log de uma compra, em ordem (aba Rastreio) |
| GET | `/metrics/errors?hours=24` | Séries de erros de negócio/não tratados por tipo e chamadas/duração por ação, gravadas via EMF (aba Métricas) |
| GET | `/metrics/sagas` | Tempo por passo das últimas 10 compras, do histórico do Step Functions (aba Desempenho) |
| GET | `/metrics/slo?hours=24` | SLOs da janela: p95 das compras concluídas, % de sagas Completed/Compensated e mensagens na DLQ há mais de 24 h (aba SLOs) |
| GET | `/dlq` | Eventos na `ProductEventsDlq` (aba DLQ) |
| POST | `/dlq/{messageId}/redrive` | Republica o evento (o Stock tenta de novo) e apaga da DLQ |
| POST | `/dlq/{messageId}/discard` | Apaga o evento da DLQ |
| GET | `/products` | Lista produtos, paginado (`?name=&priceMin=&priceMax=&limit=&nextToken=`) |
| POST | `/products` 🔑 | Cria produto `{ name, price, description?, stock? }` (`price > 0`; `stock` vira o estoque inicial no serviço de Stock) |
| GET | `/products/{id}` | Busca produto |
| GET | `/orders` | Lista pedidos, paginado (`?status=&productId=&limit=&nextToken=`) |
| GET | `/orders/{id}` | Busca pedido |
| GET | `/stock` | Estoque dos produtos, paginado (`?productId=&stockMin=&stockMax=&limit=&nextToken=`; `reserved: null` e `degraded: true` se as reservas não puderem ser lidas) |
| GET | `/stock/{productId}` | Estoque de um produto (disponível e reservado em compras em andamento; com o índice de reservas fora do ar, `reserved`/`activeReservations` vêm `null` e `degraded: true`) |
| POST | `/stock/{productId}/adjust` 🔑 | Ajusta o estoque `{ delta, name? }` (delta positivo cria o inventário se não existir; não é idempotente: depois de um 503, confira o estoque antes de repetir) |
| **POST** | **`/saga/execute`** | **Inicia uma compra** `{ productId, quantity }` + header `Idempotency-Key` (obrigatório, 400 sem ele) → 202; `503` + `Retry-After`: repita com a mesma chave |
| GET | `/saga/{sagaId}` | Andamento de uma compra |
| GET | `/sagas` | Lista as compras, paginado (`?status=&limit=&nextToken=`) |

🔑 Rota administrativa: exige o header `X-Api-Key` com a chave de admin, guardada
no SSM Parameter Store (`/<Environment>/ecommerce/admin-api-key`, SecureString) e
conferida por um authorizer Lambda do HttpApi. As demais rotas são públicas; o
stage tem throttling (100 req/s, rajada de 50).

**Paginação:** `GET /products`, `GET /stock`, `GET /orders` e `GET /sagas` devolvem até `limit` itens (padrão
50, máximo 100) e um `nextToken` quando há mais; repita a chamada com
`?nextToken=<valor>` até ele não vir. Os filtros valem para cada página, que pode
vir com menos de `limit` itens; em `/sagas` a ordem (mais recentes primeiro) vale
dentro da página. Filtro numérico inválido (`priceMin=abc`) responde `400`.

**Só as escritas da aba Admin exigem a chave:** `POST /products` e
`POST /stock/{productId}/adjust`. Listagens (`GET /sagas`, `GET /orders`),
alarmes, logs, rastreio, métricas, SLOs e a DLQ (inclusive reprocessar e
descartar) são abertos, o que serve ao laboratório mas expõe as compras de todos
e mensagens internas.

### Exposição

- **Só o API Gateway é público.** Nenhuma Lambda tem Function URL; elas recebem
  HTTP apenas pelas rotas acima.
- **Invocações internas** (exigem permissão IAM, inacessíveis pela internet):
  Step Functions → Orders/Payments/Stock (`{ action, input }`), Saga → Products
  (`getProduct`), EventBridge → Stock (`ProductCreated`, `ProductDeleted`) e → Archive. Um request HTTP
  nunca dispara uma ação: `isActionInvocation` exige ausência de `requestContext`.
- **O dashboard usa só** `/health`, `/alarms`, `/logs`, `/dlq`, `GET/POST /products`, `GET /stock`,
  `GET /orders`, `POST /saga/execute`, `GET /saga/{id}` e `GET /sagas`. A
  chave de admin (campo no topo da página) só é pedida na aba Admin, para criar produtos.
- **Confirmar/cancelar pedido, pagar/reembolsar e reservar/liberar estoque não têm
  rota HTTP**: só a saga executa essas operações, por dentro. Payments não tem
  nenhuma rota pública.
- **Escritas administrativas exigem `X-Api-Key`.** É uma
  chave única de admin, adequada ao laboratório; para usuários reais, troque
  por um authorizer JWT (Cognito ou outro IdP).

Erros de negócio: `400` validação, `402` pagamento recusado, `404` não
encontrado, `409` estado inválido, estoque insuficiente ou `Idempotency-Key`
reutilizada com outro pedido. Erros `500` não expõem detalhes internos (ficam no log).

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
│   ├── logger.mjs          # Logs JSON (LOG_LEVEL = debug | info | warn | error | silent) com métricas EMF
│   ├── emf.mjs             # Embedded Metric Format: bloco _aws da linha de log (e o inverso, para o local)
│   ├── log-query.mjs       # Filtros das abas Logs e Rastreio (CloudWatch Logs ou buffer local)
│   └── sdks/               # ProductSDK, OrderSDK, PaymentSDK, StockSDK
├── ecommerce/
│   ├── products/ orders/ payments/ stock/
│   │   ├── index.mjs       # Handler: HTTP, ação ou evento de domínio
│   │   └── src/            # routes, controllers, actions
│   └── saga-orchestrator/
│       ├── index.mjs
│       ├── src/            # routes, controller, SagaService, ProductClient, StepFunctionsClient
│       └── workflow/saga-workflow.asl.json   # gerado por scripts/generate-saga-workflow.py
└── layers/api-gateway-layer/   # /health, /alarms, /logs, /dlq e fallback 404

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

Localmente as rotas de admin ficam abertas, a menos que `ADMIN_API_KEY_HASH`
(ou `ADMIN_API_KEY`) esteja definida ao subir o `local-server`. Para deixar a
chave fixa, grave no `.env` da raiz do projeto (fora do git), que o
`npm run local-server` carrega sozinho, só o hash scrypt dela. No dashboard
você digita a chave normalmente e o servidor compara com o hash:

```bash
npm run admin:hash   # pede a chave sem mostrar no terminal e imprime ADMIN_API_KEY_HASH='scrypt$...'
```

Coloque a linha impressa no `.env`, substituindo a `ADMIN_API_KEY_HASH` (ou
`ADMIN_API_KEY`) anterior, se houver, e deixe o arquivo legível só por você
(`chmod 600 .env`).

Na AWS o hash não é usado: a chave fica no SSM Parameter Store (SecureString,
cifrada pelo KMS) e é conferida pelo authorizer.

Uma variável já definida no shell tem prioridade sobre o `.env`. Por isso ele escuta só em `127.0.0.1`; para
expor na rede, use `HOST=0.0.0.0` junto com a chave de admin (sem ela, o
servidor se recusa a subir).

Para usar o dashboard com a API publicada na AWS, abra
`http://localhost:3001/?api=<ApiGatewayUrl>`.

## Limitações conhecidas

- Eventos de domínio são publicados depois da escrita no banco, sem *outbox*
  transacional. Eventos informativos que falharem ficam só no log.
  `ProductCreated` é obrigatório: se não puder ser publicado, o produto é
  desfeito e a criação falha. Só falhas transitórias no Stock são repetidas
  (pela própria Lambda, que o EventBridge invoca de forma assíncrona) e,
  esgotadas as tentativas, vão para a DLQ `ProductEventsDlq` pelo destino
  `OnFailure` da `StockFunction` (alarme `product-events-dlq`). Falhas de
  entrega à Lambda chegam à mesma DLQ pelo `DeadLetterConfig` da regra. Erro de negócio não vai para a DLQ: fica no
  log como `DOMAIN_EVENT_REJECTED`. Reprocesse pela aba 📭 DLQ do dashboard ou
  ajuste à mão com
  `POST /stock/{id}/adjust { delta, name }`. Sem inventário, a compra falha no
  `ReserveStock`, antes de cobrar.
- O inventário é criado de forma assíncrona: logo após `POST /products`, o estoque
  pode levar um instante para aparecer em `/stock` (consistência eventual).
- A saga depende de forma síncrona do serviço de Products ao iniciar a compra.
- As listagens (`/orders`, `/sagas`, `/products`, `/stock`) usam `Scan`
  paginado, com os filtros aplicados por página. As consultas em caminhos
  críticos usam chave ou GSI (`ActiveReservationsIndex`, índice esparso das
  reservas ativas por produto).
- A autenticação é uma chave única de admin, sem usuários.
