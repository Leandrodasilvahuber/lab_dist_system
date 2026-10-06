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
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD  # senha do admin do dashboard (não fica no histórico)
export ALERT_EMAIL=voce@exemplo.com             # opcional: recebe os alarmes (confirme o e-mail da AWS)
npm run deploy       # scripts/deploy.sh: sam build + sam deploy
```

O `deploy.sh` cria no Cognito (`AdminUserPool`) o usuário `admin` (ou
`ADMIN_USERNAME`) com a senha `ADMIN_PASSWORD`, passada por arquivo temporário e
não pela linha de comando. Nos deploys seguintes `ADMIN_PASSWORD` é opcional: com
ela, a senha é trocada. A política exige 12+ caracteres com maiúscula, minúscula,
número e símbolo. Esse usuário só entra nas rotas de admin da API; não tem
permissão na conta AWS (deploy e console continuam com as credenciais do
`aws configure`). Custo: o plano Lite do Cognito é grátis até 10 mil usuários
ativos por mês.
O dashboard faz o login pelo botão Admin (descobre o Cognito por `GET /auth/config`)
e manda `Authorization: Bearer <access token>`, que vale 1 h e é renovado sozinho.
Exigem o token de admin as escritas: cadastrar e remover
produto (`POST /products`, `DELETE /products/{id}`), ajustar estoque
(`POST /stock/{id}/adjust`), ligar e desligar o caos (`PUT`/`DELETE /chaos`) e
reprocessar ou descartar eventos da DLQ (`POST /dlq/{id}/redrive|discard`),
além do custo da conta (`GET /metrics/cost` e `POST /metrics/cost/refresh`), dos logs
(`GET /logs`) e do rastreio (`GET /trace/{id}`). O resto é aberto, inclusive
pedidos e compras (`/orders`, `/sagas`), métricas e a lista da
DLQ: serve ao laboratório, mas expõe as compras de todos. Para restringir o CORS a uma origem, passe
também `AllowedOrigin=https://...` em `--parameter-overrides`.

O `sam deploy` mostra o changeset e pede confirmação antes de criar os recursos
(`confirm_changeset = true` no `samconfig.toml`). O bucket S3 dos artefatos é
criado e gerenciado pelo SAM (`resolve_s3 = true`).

**Stack criado antes do `ActiveReservationsIndex`:** a tabela de reservas trocou
o GSI `StatusIndex` pelo `ActiveReservationsIndex`, e o CloudFormation não
aceita remover e criar um GSI no mesmo update. Faça em dois deploys: primeiro
com os dois índices em `StockReservationsTable` (adicione de volta o
`StatusIndex` e o atributo `status`/`productId` ao lado do novo), depois sem o
`StatusIndex`. Reservas ativas criadas antes da troca não têm `activeProductId`
e não contam como "reservado" até terminarem; rode o deploy sem compras em andamento.

Depois do deploy, popule o catálogo e o estoque (as tabelas já foram criadas pelo stack):

```bash
# dev: todos os produtos + 7 compras de exemplo pela API (URL do output ApiGatewayUrl)
npm run seed -- --stage dev --api https://xxx.execute-api.us-east-1.amazonaws.com

# prod: só produtos e estoque, sem o produto de teste server e sem execuções
npm run seed -- --stage prod
```

O perfil vem do stage (`prod` → prod, os demais → dev) e pode ser forçado com
`--profile dev|prod`. Sem `--api`, o perfil dev grava só o catálogo e avisa.

O seed só grava o que ainda não existe: rodar de novo não mexe no estoque de
quem já está comprando nem recria produto excluído. Para voltar catálogo e
estoque aos valores do seed, use `npm run seed -- --stage dev --reset`.

## Recursos criados

| Recurso | Descrição |
|---|---|
| `ApiGateway` (HttpApi, stage `dev`) | Rotas de cada serviço + `/health`, `/alarms`, `/logs`, `/dlq` e fallback na GatewayFunction |
| `ProductFunction`, `OrderFunction`, `StockFunction` | Serviços (HTTP + ações/eventos internos) |
| `PaymentFunction` | Só ações da saga (sem rota HTTP) |
| `SagaOrchestratorFunction` | `/saga/execute`, `/saga/{id}`, `/sagas` |
| `AdminUserPool` / `AdminUserPoolClient` | Login de admin (Cognito): o JWT authorizer do HttpApi confere o token nas escritas de produto, estoque, caos e DLQ, custo, logs e rastreio (lista em `src/common/auth.mjs`) |
| `SagaStateMachine` (`dev-purchase-saga`) | Saga de compra (Step Functions Standard) |
| `GatewayFunction` | `/health`, `/alarms` (alarmes `dev-ecommerce-*`), `/logs` (linhas warn/error do `ServicesLogGroup`), `/trace/{correlationId}` (linhas de uma compra), `/metrics/errors` (métricas EMF), `/metrics/sagas`, `/metrics/slo` (SLOs da tabela de sagas e da DLQ), `/dlq` (lista, reprocessa e descarta eventos da `ProductEventsDlq`) e 404 com a lista de endpoints |
| Tabelas `dev-Products`, `dev-Orders`, `dev-Payments`, `dev-Inventory`, `dev-StockReservations`, `dev-Sagas` | DynamoDB on-demand, uma ou mais por serviço |
| `EventBus` (`dev-ecommerce-events`) | Eventos de domínio dos serviços |
| `ProductEventsToStockRule` | Entrega `ProductCreated`/`ProductDeleted` à `StockFunction` (cria/remove o inventário), com DLQ `ProductEventsDlq` para falhas de entrega. Erros da função são repetidos pela própria Lambda (invocação assíncrona, `EventInvokeConfig` da `StockFunction`) e, esgotadas as tentativas, vão para a mesma DLQ pelo destino `OnFailure` (só falhas transitórias; erro de negócio fica no log como `DOMAIN_EVENT_REJECTED`) |
| `OrderEventsArchive` (`dev-order-events`) | EventBridge Archive dos eventos `source: orders` (auditoria e replay, 10 dias) |
| `ServicesLogGroup` (`/aws/lambda/dev-ecommerce`) | Logs de todas as Lambdas, 14 dias (campo `service` = função). Erro tratado sai com `status: warn`, não tratado com `status: error` + stack |
| Métricas `Ecommerce/dev` (EMF) | Sem recurso próprio: as linhas de log carregam o bloco `_aws` e o CloudWatch extrai `UnhandledErrors`, `BusinessErrors` (por `ErrorType`), `ClientErrors` (leituras com 404, fora dos alarmes) e `ActionCount`/`ActionDuration` (por ação) |
| Agendamento `ReconcileSagas` | A cada 5 min, a `SagaOrchestratorFunction` confere no Step Functions (`states:DescribeExecution`) as sagas paradas em andamento há mais de 5 min e grava o status final (log `error SAGA_RECONCILED`) |
| Alarmes `dev-ecommerce-*` | `unhandled-errors` (inclui `SAGA_RECONCILED`), `business-errors` (≥ 20 erros de negócio em 5 min), `product-events-dlq` (mensagens na DLQ), `saga-failed` (saga que nem a compensação fechou: `CompensationFailed`, `SagaFailed`, timeout; compensação normal não conta), `saga-compensation-rate` (> 5% das sagas compensadas em 5 min, com pelo menos 20 execuções), `circuit-open` (circuit breaker do serviço de Products aberto: compras recusadas com 503), `api-5xx`; aparecem na aba Monitoramento do dashboard; `client-errors` (≥ 300 leituras com 404 em 5 min: cliente em loop), `sagas-stuck` (saga parada que a reconciliação não fechou, em 2 varreduras seguidas), `lambda-throttles` (invocações recusadas por falta de concorrência), `purchase-limit` (limite diário de compras atingido: vendas paradas até as 12:00; avisa no máximo uma vez por hora e não avisa a volta a OK). Todos avisam o tópico SNS `dev-ecommerce-alarms` (output `AlarmTopicArn`) ao entrar em ALARM e, exceto o `purchase-limit`, ao voltar a OK |
| Dashboard CloudWatch `dev-ecommerce` | Saúde agregada numa tela: sagas por minuto, taxa de sucesso e de compensação, latência p50/p95/p99 por etapa (`ActionDuration`), erros, throttles (Lambda, Step Functions, API, DynamoDB), DLQ e alarmes. URL no output `HealthDashboardUrl` |
| SLOs `dev-ecommerce-slo-*` (Application Signals) | `saga-outcome` (≥ 99,5% das sagas em Completed ou Compensated), `purchase-latency` (p95 da execução < 2 s em 99% das janelas de 5 min), `dlq-age` (mensagem mais antiga da DLQ < 24 h). Janela móvel de 1 dia, burn rate de 60 min |
| Consultas salvas `ecommerce/dev/*` (Logs Insights) | `Rastreio por correlationId` (Lambdas + state machine), `Erros por evento`, `Etapas mais lentas` |

Cada função recebe só as permissões de que precisa, e cada serviço acessa apenas
as próprias tabelas:

| Função | Tabelas | Outros acessos |
|---|---|---|
| `ProductFunction` | `Products` | publica eventos |
| `OrderFunction` | `Orders` | publica eventos |
| `PaymentFunction` | `Payments` | publica eventos |
| `StockFunction` | `Inventory`, `StockReservations` | publica eventos; recebe `ProductCreated` e `ProductDeleted` (falhas vão para `ProductEventsDlq`) |
| `GatewayFunction` | `Sagas` (leitura, aba SLOs) | lê alarmes e métricas (CloudWatch) e logs (`ServicesLogGroup`); lê/apaga mensagens da `ProductEventsDlq` e republica eventos no `EventBus` (reprocessamento) |
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

# Listagens de todas as compras e pedidos
curl $API/orders
curl $API/sagas

# Rota de admin: access token do Cognito (vale 1 h)
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name distributed-ecommerce-system \
  --query "Stacks[0].Outputs[?OutputKey=='AdminUserPoolClientId'].OutputValue" --output text)
TOKEN=$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id $CLIENT_ID \
  --auth-parameters USERNAME=admin,PASSWORD="$ADMIN_PASSWORD" --query AuthenticationResult.AccessToken --output text)
curl -X POST -H "Authorization: Bearer $TOKEN" $API/stock/apple/adjust -d '{"delta": 10}'

# Pagamento recusado (produto de 25000 > limite de 10000): saga termina COMPENSATED
curl -X POST $API/saga/execute -H "Idempotency-Key: $(uuidgen)" -d '{"productId": "server", "quantity": 1}'

# Estoque insuficiente: falha antes de cobrar; pedido cancelado
curl -X POST $API/saga/execute -H "Idempotency-Key: $(uuidgen)" -d '{"productId": "apple", "quantity": 999}'
```

No console do Step Functions (máquina `dev-purchase-saga`) dá para ver cada
execução como diagrama: o passo que falhou e as compensações executadas.

## Logs

```bash
sam logs --stack-name distributed-ecommerce-system -n OrderFunction --tail
sam logs --stack-name distributed-ecommerce-system -n SagaOrchestratorFunction --tail
```

Os logs são JSON (um por linha). Para reconstruir uma compra inteira, abra o
CloudWatch Logs Insights → Consultas salvas → `ecommerce/dev/Rastreio por correlationId`
e troque `COLE_O_CORRELATION_ID` pelo id: a consulta lê o `ServicesLogGroup` e o
log da state machine e ordena tudo no tempo. Para a visão agregada (testes de carga
e chaos), use o dashboard do output `HealthDashboardUrl`.

## SLOs

Os critérios de sucesso dos testes ficam em dois lugares, com as mesmas metas
(`SLO_TARGETS` em `src/layers/api-gateway-layer/src/services/SloClient.js`):

- **Aba 🎯 SLOs do dashboard** (`GET /metrics/slo`): calcula na hora, a partir
  da tabela `dev-Sagas` e da DLQ. Mede só as compras `COMPLETED` na latência e
  separa compensação de falha pelo `status` da saga. Funciona igual no LocalStack.
- **CloudWatch → Application Signals → Service Level Objectives**: os SLOs
  `dev-ecommerce-slo-*` do template, com histórico, error budget e burn rate.
  Diferenças em relação à aba: a latência usa `AWS/States ExecutionTime`, que
  inclui as sagas compensadas, e é avaliada por janelas de 5 min; o desfecho
  vem dos metric filters `SagaCompensations`/`SagaUnrecovered` e das métricas
  do Step Functions.

## Custo

Para um laboratório, o uso tende a ficar dentro do free tier. Valores de
referência (us-east-1, confira as páginas de preço antes de escalar):

| Serviço | Cobrança | Observação |
|---|---|---|
| Lambda | por requisição + duração | 1M requisições/mês grátis |
| Step Functions Standard | por transição de estado (~US$ 0,025 / 1.000) | 4.000 transições/mês grátis; ~12 por compra sem compensação |
| API Gateway HttpApi | por requisição | |
| DynamoDB on-demand | por leitura/escrita | |
| EventBridge | por evento publicado | |
| Application Signals (SLOs) | por SLO e por métrica avaliada | 3 SLOs; confira o preço do CloudWatch Application Signals |

A aba 🧠 **Recursos** do dashboard mostra o custo de duas formas:

- **Estimado**: métricas grátis (`AWS/Lambda`, `AWS/States`, `AWS/ApiGateway`,
  `AWS/DynamoDB`) × a tabela `PRICES` de `CostClient.js`, sem free tier.
- **Real**: Cost Explorer (custo da **conta inteira**), com previsão do mês. Cada
  chamada à API custa US$ 0,01 (US$ 0,02 por leitura, com a previsão), então a
  rota nunca chama o Cost Explorer: uma regra agendada (`RefreshCost`, a cada
  6 h) lê e grava o resultado na tabela `<env>-CostSnapshots`, e o
  `GET /metrics/cost` só lê esse item. O custo fica fixo em ~4 leituras por dia
  (~US$ 2,40/mês), qualquer que seja o tráfego. O botão *Atualizar agora* da aba
  Recursos (`POST /metrics/cost/refresh`) lê na hora, no máximo uma vez a cada
  15 min (trava condicional no DynamoDB, valendo também para a regra agendada)
  e até 5 vezes por dia (`DailyCostRefreshLimit`, zera às 12:00 de Brasília; a
  regra agendada não conta), no máximo ~US$ 3/mês a mais.
  Logo depois do deploy ainda não há leitura: use o botão ou espere a regra. As
  duas rotas exigem a chave de admin; `?days=` aceita só 7, 14, 30 ou 90, para
  que trocar o período não fure o cache da estimativa. Numa conta nova, o Cost Explorer precisa ser ativado uma vez no console
  (Billing → Cost Explorer) e leva até 24 h para ter dados.

A métrica de memória (`MemoryUsedMB`, uma série por Lambda) é métrica custom:
cerca de US$ 0,30 por série por mês, ~US$ 2/mês para as 7 funções.

O `MonthlyBudget` (AWS Budgets, parâmetro `MonthlyBudgetUSD`, padrão US$ 5)
avisa no tópico dos alarmes (e no `AlertEmail`) com 80% do teto gasto e quando
a previsão do mês passa de 100%. Para mudar o teto:
`sam deploy --parameter-overrides MonthlyBudgetUSD=10 ...`.

**Interruptor de custo.** Quando o gasto real passa de 100% do teto, um segundo
Budget (`dev-ecommerce-kill-switch`, mesmo `MonthlyBudgetUSD`) publica no tópico `dev-ecommerce-cost-kill-switch` e a `CostKillSwitchFunction`
zera o throttling do stage. A partir daí toda requisição recebe 429 do API
Gateway, sem chegar às Lambdas. Os limites anteriores ficam no parâmetro
`/dev/ecommerce/throttle-backup` do SSM. O `AlertEmail` também assina esse
tópico. A função só age com o alerta de teto estourado do Budget ou com o
`ApiFloodAlarm` entrando em ALARM (mais de `FloodRequestsPer5Min` requisições
em 5 min, por 10 min); qualquer outra mensagem no tópico é ignorada (e
registrada no log). O Budget é atualizado algumas vezes por dia, então o
bloqueio por ele chega com horas de atraso; o alarme de volume pega um script
em ~10 min. Para religar a API (um
novo deploy não desfaz o bloqueio, porque o CloudFormation não corrige
mudanças feitas fora dele):

```bash
FN=$(aws cloudformation describe-stack-resource --stack-name distributed-ecommerce-system \
  --logical-resource-id CostKillSwitchFunction --query StackResourceDetail.PhysicalResourceId --output text)
aws lambda invoke --function-name "$FN" --cli-binary-format raw-in-base64-out \
  --payload '{"action":"restore"}' /dev/stdout
```

Para testar o bloqueio sem esperar o Budget, invoque a mesma função com
`--payload '{"action":"trip"}'` e depois religue com o `restore`.

Cuidados:
- Um deploy que **mude** os limites por rota durante o bloqueio reaplica os
  limites do template e a API volta a responder. Nesse caso não rode o
  `restore`: o backup guarda os limites de antes do deploy.
- O Budget avisa uma vez por mês. Depois de um `restore`, um novo gasto acima
  do teto no mesmo mês não bloqueia de novo; só os limites por rota seguram.
- O `restore` devolve o `ApiFloodAlarm` para OK. Se o ataque continuar, ele
  volta a ALARM na avaliação seguinte e bloqueia de novo; religue depois de
  10 min sem o volume alto.

Cada requisição custa API Gateway + Lambda + DynamoDB: um cliente com bug em
loop (como abas esquecidas consultando sagas apagadas) ou um script de propósito
vira custo. O throttling do template é **por rota**, somando todos os clientes:
o padrão (10 req/s) vale para cada rota sem limite próprio. As rotas que leem
o CloudWatch têm limites menores e reaproveitam a leitura por alguns segundos:
as métricas, públicas, e os logs e o rastreio, que são de admin. O AWS WAF não se associa a um
HttpApi; para limitar por IP, coloque um CloudFront com WAF (rate-based rule)
na frente da API.

## Removendo tudo

```bash
sam delete --stack-name distributed-ecommerce-system
```

Isso apaga as tabelas e os dados junto com o stack.
