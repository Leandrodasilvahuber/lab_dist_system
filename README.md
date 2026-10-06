# 🛒 Distributed Systems Playground - E-Commerce

Laboratório de sistemas distribuídos na AWS: um e-commerce serverless em que a
compra é uma **saga orquestrada pelo AWS Step Functions**, assíncrona e com
compensação automática.

## Stack

- **Node.js 22** em **AWS Lambda** (arm64), empacotado com esbuild
- **API Gateway HttpApi**
- **AWS Step Functions** (Standard) para orquestrar a saga de compra
- **DynamoDB** (on-demand), com transações e escritas condicionais
- **EventBridge** para eventos de domínio (Archive dos eventos de pedidos para auditoria e SQS DLQ para eventos que falharam)
- **CloudWatch** para logs JSON, métricas EMF, alarmes, dashboard e SLOs (Application Signals)
- **AWS SAM** para infraestrutura e deploy, **LocalStack** para rodar localmente

## Arquitetura

```
                        ┌──────────────────────── API Gateway (HttpApi) ─────────────────────────┐
                        │ /products  /orders             /stock      /saga/*  /sagas  /health …  │
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
    Stock ──getProduct (Lambda invoke, síncrono)──▶ Products              só no ajuste que cria o inventário
    Products ──ProductCreated/Deleted (EventBridge, assíncrono)──▶ Stock  cria/remove o inventário
  Gateway: /health, /alarms, /logs, /trace, /metrics/*, /dlq (observabilidade)

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

**Prazo:** sem throttling, a compra conclui ou é desfeita em até ~5 min. Cada passo tem limite
de 5 s (no LocalStack, 30 s, o timeout das Lambdas locais: lá o cold start sobe
um contêiner; e no máximo 2 execuções ao mesmo tempo): um passo lento vira `States.Timeout`, é repetido e,
se continuar falhando, compensado como qualquer falha. Throttling da Lambda
(`Lambda.TooManyRequestsException`: pico de compras, ou mais de 2 simultâneas no
LocalStack) tem retry próprio, mais paciente (6 tentativas, até ~70 s de espera
por passo), e a consulta ao produto no início da compra também espera um pouco
antes de responder 503. O teto da execução (30
min) é só rede de segurança, porque quando ele estoura o Step Functions encerra
**sem compensar**. Um teste (`test/unit/saga/workflow.test.mjs`) calcula o pior
caso a partir do próprio ASL.

**Saga parada:** se a execução terminou mas a gravação do status final falhou
(ou a execução estourou o teto), a saga ficaria `RUNNING` para sempre. Saga em
andamento sem atualização há mais de 5 min é conferida no Step Functions
(`DescribeExecution`) e recebe o status final, ou `COMPENSATION_FAILED`
(intervenção manual) quando a execução terminou sem compensar. Isso acontece no
`GET /saga/{id}` e numa varredura a cada 5 min (agendada no template; no
`local-server`, a cada minuto), com log `error SAGA_RECONCILED`.

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
| `ClientErrors` | total, `ErrorType` | leitura (`GET`/`HEAD`) que respondeu 404: linha `info`, fora dos alarmes. Um cliente consultando o que não existe (id antigo, robô) aparece na aba Métricas sem disparar o `business-errors` |
| `UnhandledErrors` | total, `ErrorType` | toda linha `error` (alarme `unhandled-errors`) |
| `ActionCount`, `ActionDuration` (ms) | `Action`+`Outcome` (`ok`/`rejected`/`failed`) | cada ação da saga e evento de domínio (`src/common/actions.mjs`) |
| `MemoryUsedMB` | `FunctionName` | toda invocação (`src/common/runtime-metrics.mjs`): RSS do processo ao fim da invocação, aproximação do *Max Memory Used* |
| `InvocationDurationMs` | `FunctionName` | só no perfil local: base da estimativa de custo, já que o LocalStack não publica `AWS/Lambda Duration` |

Linhas abaixo do `LOG_LEVEL` não somem das métricas: sai uma linha mínima, sem
`status`, só com os campos EMF. Os alarmes `unhandled-errors` e
`business-errors` (≥ 20 em 5 min) usam essas métricas.

No dashboard: 📊 **Métricas** (séries por tipo de erro e tabela por ação),
📜 **Logs** (warn/error), 🔎 **Rastreio** (estado da saga + todas as linhas
do mesmo `correlationId`, de todos os serviços), ⏱️ **Desempenho** (últimas 10
compras em detalhe), 🎯 **SLOs** (p95 da compra < 2 s, ≥ 99,5% das sagas em
Completed/Compensated, nenhuma mensagem na DLQ há mais de 24 h),
🧠 **Recursos** (memória por Lambda contra o `MemorySize` e custo por serviço:
estimado pelas métricas × tabela de preços, e o real do Cost Explorer na AWS) e
🩺 **Monitoramento** (alarmes).

O custo também tem um aviso: o `MonthlyBudget` (AWS Budgets, parâmetro
`MonthlyBudgetUSD`, padrão US$ 5) publica no mesmo tópico dos alarmes quando o
gasto do mês passa de 80% ou a previsão passa do teto.

A aba SLOs lê só as sagas da janela pelo índice `SagasByDayIndex` (dia de
criação dividido em 10 shards, ver `src/common/saga-day-index.mjs`), sem varrer
a tabela. Sagas criadas antes do índice precisam da chave: depois do deploy,
rode uma vez `npm run backfill:sagas -- --stage dev` (local:
`npm run backfill:sagas:local`).

## API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/alarms` | Alarmes do CloudWatch do ambiente (aba Monitoramento) |
| GET | `/logs?level=warn\|error&hours=24` | Linhas de log warn/error, mais recentes primeiro (aba Logs) |
| GET | `/trace/{correlationId}` | Todas as linhas de log de uma compra, em ordem (aba Rastreio) |
| GET | `/metrics/errors?hours=24` | `hours`: 1, 3, 24, 168 ou 336 (outro valor vai para o mais próximo). Séries de erros de negócio/não tratados por tipo e chamadas/duração por ação, gravadas via EMF (aba Métricas) |
| GET | `/metrics/sagas` | Tempo por passo das últimas 10 compras, do histórico do Step Functions (aba Desempenho) |
| GET | `/metrics/slo?hours=24` | `hours`: 1, 24 ou 168. SLOs da janela: p95 das compras concluídas, % de sagas Completed/Compensated e mensagens na DLQ há mais de 24 h (aba SLOs) |
| GET | `/metrics/memory?hours=3` | `hours` como em `/metrics/errors`. Memória máxima e média por Lambda (`MemoryUsedMB`) e o limite configurado (aba Recursos) |
| GET | `/metrics/cost?days=14` 🔑 | `days`: 7, 14, 30 ou 90. Custo por serviço e por dia: estimado (métricas × preços) e, na AWS, o real e a previsão do mês pela última leitura do Cost Explorer (aba Recursos; é o gasto da conta inteira). Não chama o Cost Explorer: ele é lido a cada 6 h por uma regra agendada |
| POST | `/metrics/cost/refresh` 🔑 | Lê o Cost Explorer agora (US$ 0,02), no máximo uma vez a cada 15 min; antes disso responde 429 com `Retry-After`. Até 5 por dia (`DailyCostRefreshLimit`; zera às 12:00 de Brasília; a leitura agendada não conta): depois, 429 com `code: CostRefreshLimitExceeded`. 503 no LocalStack |
| GET | `/dlq` | Eventos na `ProductEventsDlq` (aba DLQ) |
| POST | `/dlq/{messageId}/redrive` 🔑 | Republica o evento (o Stock tenta de novo) e apaga da DLQ |
| POST | `/dlq/{messageId}/discard` 🔑 | Apaga o evento da DLQ |
| GET | `/chaos` | Falhas injetadas em vigor (`enabled`, `active`, `expiresAt`, `faults`); ver [Engenharia de caos](#engenharia-de-caos) |
| PUT | `/chaos` 🔑 | Liga falhas `{ expiresAt, faults: [{ service, action?, type, probability?, latencyMs? }] }` (substitui as anteriores) |
| DELETE | `/chaos` 🔑 | Desliga todas as falhas |
| GET | `/products` | Lista produtos, paginado (`?name=&priceMin=&priceMax=&limit=&nextToken=`) |
| POST | `/products` 🔑 | Cria produto `{ name, price, description?, stock? }` (`price > 0`; `stock` vira o estoque inicial no serviço de Stock) |
| GET | `/products/{id}` | Busca produto |
| DELETE | `/products/{id}` 🔑 | Remove o produto; o Stock remove o inventário pelo evento `ProductDeleted` (se a publicação falhar, o produto volta e a chamada pode ser repetida) |
| GET | `/orders` | Lista pedidos, paginado (`?status=&productId=&limit=&nextToken=`) |
| GET | `/orders/{id}` | Busca pedido |
| GET | `/stock` | Estoque dos produtos, paginado (`?productId=&stockMin=&stockMax=&limit=&nextToken=`; `reserved: null` e `degraded: true` se as reservas não puderem ser lidas) |
| GET | `/stock/{productId}` | Estoque de um produto (disponível e reservado em compras em andamento; com o índice de reservas fora do ar, `reserved`/`activeReservations` vêm `null` e `degraded: true`) |
| POST | `/stock/{productId}/adjust` 🔑 | Ajusta o estoque `{ delta, name? }` (delta positivo cria o inventário se não existir; não é idempotente: depois de um 503, confira o estoque antes de repetir) |
| **POST** | **`/saga/execute`** | **Inicia uma compra** `{ productId, quantity }` (`quantity` de 1 a 1000) + header `Idempotency-Key` (obrigatório, 400 sem ele) → 202; `503` + `Retry-After`: repita com a mesma chave; `429` (`code: PurchaseLimitExceeded`, `scope: total` ou `client`): passou do limite diário de compras novas (`DailyPurchaseLimit`, padrão 150, e `DailyPurchaseLimitPerClient`, padrão 20 por IP; zera às 12:00 de Brasília; desligados no local-server; para o `npm run chaos` na AWS, faça o deploy com os dois em 0) |
| GET | `/saga/{sagaId}` | Andamento de uma compra |
| GET | `/sagas` | Lista as compras, paginado (`?status=&limit=&nextToken=`); `?recent=N` (1 a 50) devolve as N mais recentes das últimas 24 h, pelo índice por dia (tela Comprar) |

🔑 Rota administrativa: exige o header `X-Api-Key` com a chave de admin, guardada
no SSM Parameter Store (`/<Environment>/ecommerce/admin-api-key`, SecureString) e
conferida por um authorizer Lambda do HttpApi. São de admin as escritas: cadastrar
e remover produto, ajustar estoque, ligar e desligar o caos e reprocessar ou
descartar eventos da DLQ (descartar perde o evento de vez). O custo também, por
ser o gasto da conta AWS inteira. As demais rotas são públicas, inclusive
pedidos, compras, logs, rastreio e a lista da DLQ, o que serve ao laboratório
mas expõe as compras de todos e mensagens internas. O
stage tem throttling (100 req/s, rajada de 50), e as leituras caras têm limite
próprio (`RouteSettings` no template; `GET /saga/{id}`, o polling do dashboard,
20 req/s). O limite é da rota, somando todos os clientes.

**Paginação:** `GET /products`, `GET /stock`, `GET /orders` e `GET /sagas` devolvem até `limit` itens (padrão
50, máximo 100) e um `nextToken` quando há mais; repita a chamada com
`?nextToken=<valor>` até ele não vir. Os filtros valem para cada página, que pode
vir com menos de `limit` itens; em `/sagas` a ordem (mais recentes primeiro) vale
dentro da página. Filtro numérico inválido (`priceMin=abc`) responde `400`.

### Exposição

- **Só o API Gateway é público.** Nenhuma Lambda tem Function URL; elas recebem
  HTTP apenas pelas rotas acima.
- **Invocações internas** (exigem permissão IAM, inacessíveis pela internet):
  Step Functions → Orders/Payments/Stock (`{ action, input }`), Saga → Products
  (`getProduct`), EventBridge → Stock (`ProductCreated`, `ProductDeleted`) e → Archive. Um request HTTP
  nunca dispara uma ação: `isActionInvocation` exige ausência de `requestContext`.
- **O dashboard usa só** `/health`, `/alarms`, `/logs`, `/trace/{id}`, `/metrics/*`,
  `/dlq` (e `POST /dlq/{id}/redrive|discard`), `GET/POST /products`, `DELETE /products/{id}`, `GET /stock`,
  `GET /orders`, `POST /saga/execute`, `GET /saga/{id}` e `GET /sagas`. A
  chave de admin (botão no topo da página) é pedida nas abas Admin e Caos, nas
  ações da DLQ e no custo da aba Recursos.
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
npm run localstack:deploy # publica Lambdas e saga no LocalStack (para o dashboard)
npm run local-server      # dashboard em http://localhost:3001
npm run seed:local        # dev: produtos + compras de exemplo (seed:local:prod: só produtos)
npm run test:integration  # SDKs contra o DynamoDB do LocalStack
npm run test:e2e          # saga completa: Lambda + Step Functions + DynamoDB
npm run chaos             # experimentos de caos contra o local-server (ou --api <url>)

# AWS: veja AWS-SETUP.md
npm run deploy
npm run seed -- --stage dev --api <ApiGatewayUrl>   # ou --stage prod: só produtos
```

O workflow é gerado a partir de `scripts/generate-saga-workflow.py`; depois de
alterar o fluxo, rode `npm run generate:workflow`.

## Dashboard

O dashboard (`dashboard/`), servido pelo `local-server.mjs`, permite comprar e
acompanhar cada saga em tempo real: os passos concluídos, o que falhou e as
compensações executadas. As telas ficam agrupadas por assunto: **Loja**
(comprar, produtos, estoque, pedidos, resumo), **Observabilidade**
(monitoramento, métricas, logs, rastreio, desempenho, SLOs, recursos) e **Operação**
(DLQ, caos, admin). A tela atual fica na URL (`#/slo`), e há tema claro e escuro.

Sem build: são módulos ES carregados direto pelo navegador.

| Pasta | Conteúdo |
| --- | --- |
| `dashboard/index.html` | Esqueleto: barra lateral, topo e área das telas |
| `dashboard/css/` | `tokens.css` (cores dos temas e dos grupos), `layout.css`, `components.css` |
| `dashboard/js/core/` | API, sessão de admin, eventos entre telas, navegação (router) |
| `dashboard/js/components/` | Peças reutilizáveis: ícones, cartões, tabelas, selos, gráfico, cartão da saga |
| `dashboard/js/views/` | Uma tela por arquivo; `index.js` define os grupos do menu |

Para criar uma tela, crie um módulo em `views/` com `{ id, label, icon,
template(), mount(), refresh() }` e coloque-o num grupo em `views/index.js`.

O `local-server.mjs` funciona como um API Gateway local: monta o mesmo evento
que o HttpApi envia e chama os handlers reais dos serviços, com o DynamoDB e a
state machine no LocalStack. É o mesmo código que vai para a AWS.

```bash
npm run localstack:start
npm run build && npm run localstack:deploy   # publica as Lambdas e a saga no LocalStack
npm run local-server                         # abra http://localhost:3001
npm run seed:local                           # dev; npm run seed:local:prod só com o catálogo
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

## Engenharia de caos

Falhas controladas nos serviços mostram retry, compensação, circuit breaker e
DLQ agindo. O módulo `src/common/chaos.mjs` roda antes de cada ação da saga,
evento e rota HTTP (`runAction` e `createServiceHandler`). Ele lê a configuração de um
parâmetro do SSM (`/<Environment>/ecommerce/chaos`). O parâmetro é compartilhado porque
cada Lambda roda no próprio container. Mudanças levam até 10 s para chegar (cache).

| Tipo | O que acontece | Caminho exercitado |
|---|---|---|
| `latency` | espera `latencyMs` | latência, SLO; acima de 5 s, `States.Timeout` e retry do passo |
| `transient` | `ThrottlingException` | `TransientError` → retry do Step Functions; em evento, retry e DLQ; em HTTP, 503 |
| `crash` | erro comum | passo da saga vai direto para a compensação; em `products/getProduct`, abre o circuit breaker |
| `unavailable` | `DependencyUnavailableError` | 503 com `Retry-After` |

Alvo: `service` (`products`, `orders`, `payments`, `stock`, `saga`) e
`action` opcional. A ação pode ser a da saga (`processPayment`), o evento
(`products/ProductCreated`) ou a rota (`POST /saga/execute`).

**Proteções:**
- `expiresAt` é obrigatório e fica no máximo 60 min à frente: o caos desliga sozinho.
- Em `prod`, `CHAOS_ENABLED=false` e o SSM nem é lido.
- Se a config não puder ser lida, não há caos (falha aberta).
- Cada injeção grava `CHAOS_INJECTED` no rastreio da compra e a métrica `ChaosInjected` (dimensões `Service` e `Fault`).
- Enquanto há falhas ativas, o dashboard mostra uma faixa de alerta em todas as telas.

**Aba Caos (admin):** formulário para injetar uma falha, lista das ativas e os
experimentos prontos de `dashboard/js/services/chaos-presets.js`.

**Experimentos automáticos:** `npm run chaos` (ou `npm run chaos -- payment-down --orders 10`).
Cada experimento tem uma hipótese. O script liga as falhas, dispara compras pela API e
confere o status final das sagas (ou o 503 com `Retry-After`). No fim confere a
invariante do estoque: disponível = antes − vendidos, sem reserva ativa. O caos é
desligado mesmo com erro ou Ctrl+C. Contra a AWS use `--api <ApiGatewayUrl>` e
`ADMIN_API_KEY` no ambiente. O `event-dlq` só roda na AWS, porque localmente não há
EventBridge nem DLQ.

Localmente o LocalStack precisa de `ssm` em `SERVICES` (`docker-compose.yml`), e
`npm run localstack:deploy` cria o parâmetro `/local/ecommerce/chaos`.

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
- A saga depende de forma síncrona do serviço de Products ao iniciar a compra; o
  Stock, só no ajuste que criaria o inventário (`POST /stock/{id}/adjust` com
  delta positivo para um produto sem inventário: confere se o produto existe).
- As listagens (`/orders`, `/sagas`, `/products`, `/stock`) usam `Scan`
  paginado, com os filtros aplicados por página. As consultas em caminhos
  críticos usam chave ou GSI (`ActiveReservationsIndex`, índice esparso das
  reservas ativas por produto).
- A autenticação é uma chave única de admin, sem usuários.
