# 🚀 Desenvolvimento local com LocalStack

O LocalStack emula DynamoDB, Lambda, Step Functions, EventBridge e SQS na sua
máquina, na porta 4566.

## Pré-requisitos

- Docker com Docker Compose
- Node.js 22+
- AWS SAM CLI (para `npm run build`)
- Python 3 (usado para empacotar as Lambdas no teste e2e)

> O `docker-compose.yml` usa `localstack/localstack:4.14.0`, a última versão que
> roda sem conta. As versões por data (`2026.x`) e a `latest` exigem
> `LOCALSTACK_AUTH_TOKEN` (conta gratuita no plano Hobby). A 4.14 suporta o
> runtime `nodejs22.x`, o mesmo do deploy, mas não recebe mais atualizações;
> se um dia precisar de algo mais novo, crie a conta, troque a imagem e defina
> `LOCALSTACK_AUTH_TOKEN` no `docker-compose.yml`.
>
> O socket do Docker é montado porque o LocalStack executa as Lambdas em containers.

## Passo a passo

```bash
npm install

# 1. Sobe o LocalStack
npm run localstack:start

# 2. Cria as tabelas, publica as Lambdas e a saga no LocalStack e abre o dashboard
npm run build              # empacota as Lambdas
npm run localstack:deploy  # repita depois de mudar o código (após npm run build)
npm run local-server       # http://localhost:3001

# 3. Popula os dados (em outro terminal, com o local-server rodando)
#    (de novo, só grava o que falta; -- --reset volta catálogo e estoque aos valores do seed)
npm run seed:local         # dev: catálogo + estoque + 7 compras de exemplo
npm run seed:local:prod    # ou prod: só catálogo e estoque, sem execuções nem métricas

# 4. Testes contra o LocalStack
npm run test:integration   # SDKs contra o DynamoDB
npm run test:e2e           # saga completa: Lambda + Step Functions + DynamoDB
npm run test:e2e:errors    # provoca erros tratados/não tratados e cria alarmes locais

# 5. Para tudo
npm run localstack:stop
```

O seed tem dois perfis (`scripts/seed.mjs`):

| Perfil | Comando | Grava |
|---|---|---|
| dev | `npm run seed:local` | os 5 produtos e o estoque, e envia 7 compras de exemplo pela API do `local-server` |
| prod | `npm run seed:local:prod` | só o necessário para comprar: produtos e estoque, sem o `server` (`devOnly` em `seed-products.json`) |

Das compras de exemplo do dev, a do server tem o pagamento recusado e a de 999
oranges passa do estoque; as duas terminam em compensação e aparecem na aba
⏱️ Desempenho. As chaves de idempotência são fixas: rodar o seed de novo não
compra outra vez. Com o `local-server` parado, o seed grava os produtos e avisa
que as compras ficaram de fora; `--no-orders` pula as compras de propósito.
O `local-server` não cria dados sozinho: numa base nova, sem seed, o dashboard
começa vazio.

O `test:e2e` cria funções, tabelas e a state machine com um prefixo próprio
(`e2e-<timestamp>`), roda os cenários de compra e remove tudo ao final, sem
interferir nos dados do seed.

## Ver erros e alarmes

`npm run test:e2e:errors` provoca cada tipo de erro com os handlers reais e
mostra as linhas de log geradas:

| Cenário | Resultado | Log |
|---|---|---|
| `POST /products` com preço 0 | 400 | `warn API_REJECTED` (`BusinessErrors`, `HTTP_400`) |
| `GET /saga/{id}` de saga que não existe | 404 | `info API_REJECTED` (`ClientErrors`, `HTTP_404`; fora do alarme `business-errors`) |
| Ação `confirmOrder` de pedido inexistente | lança `NotFound` | `warn ACTION_REJECTED` (`BusinessErrors`, `NotFound`) |
| `ProductCreated` com `initialStock: -1` | evento confirmado, **sem DLQ** | `warn DOMAIN_EVENT_REJECTED` (`BusinessErrors`, `ValidationError`) |
| `ProductCreated` sem a tabela de inventário | 3 tentativas e depois DLQ `local-ProductEventsDlq` | `error ACTION_FAILED` + stack |
| `GET /stock` sem a tabela de inventário | 500 sem detalhes | `error UNEXPECTED_ERROR` + stack |
| 6 compras com o serviço de produtos fora do ar (endpoint do Lambda recusa a conexão) | 5× 503 com `Retry-After`; o circuit breaker abre e a 6ª é recusada na hora, sem invocar | `error DEPENDENCY_UNAVAILABLE` por falha da Lambda + `error CIRCUIT_STATE_CHANGED` (`CircuitOpened`, `Circuit=products`); a recusa com o circuito aberto é `info` |

No fim, ele cria os alarmes `local-ecommerce-*` (os mesmos do `template.yaml`)
no CloudWatch do LocalStack e espera o LocalStack avaliá-los. Na AWS as
métricas de erro saem das próprias linhas de log (Embedded Metric Format, bloco
`_aws`); o LocalStack guarda os logs mas não extrai EMF, nem publica métricas de
SQS/API Gateway/Step Functions. Por isso o script publica em `Ecommerce/local`
as métricas EMF das linhas geradas e os valores observados (mensagens na DLQ,
respostas 5xx, aberturas do circuito). Os alarmes locais usam período de 60 s, limiar 0 (na AWS,
`business-errors` só dispara com 20 em 5 min) e ficam ~15 min em ALARM.
`saga-failed` e `saga-compensation-rate` (limiar 5%) ficam em OK: o teste não
executa saga, e na AWS eles vêm de metric filters no log da state machine,
que o LocalStack não aplica. O
LocalStack às vezes avalia um alarme antes de ver o ponto; se um ficar em OK,
rode de novo. Abra `npm run local-server` → aba
🩺 Monitoramento para ver a tabela. Para apagar alarmes e DLQ:
`npm run test:e2e:errors -- --cleanup`.

A aba 📭 **DLQ** lista os eventos que o teste deixou na `local-ProductEventsDlq`
(o `ProductCreated` de `p-transitorio`). ♻️ Reprocessar entrega o evento de novo
ao Stock (cria o item "Transitório" no estoque local); 🗑️ Descartar só apaga.

## Métricas e rastreio no local-server

O `local-server` faz o papel do CloudWatch com um agente EMF
(`scripts/lib/emf-agent.mjs`): as linhas dos handlers que rodam no processo e,
a cada 10 s, as dos log groups `/aws/lambda/local-*` (os passos da saga, que
rodam como Lambdas no LocalStack) têm as métricas do bloco `_aws` publicadas
com `PutMetricData` em `Ecommerce/local`. Ao subir, ele lê a última hora desses
log groups só para as abas de log (sem republicar métricas).

- 📊 **Métricas**: erros de negócio e não tratados por tipo, e chamadas,
  rejeições, falhas e duração por ação. Lê o CloudWatch do LocalStack.
- 📜 **Logs**: linhas warn/error.
- 🔎 **Rastreio**: estado da saga e todas as linhas do mesmo `correlationId`.
- 🎯 **SLOs**: calculados da tabela `sagas` e da `local-ProductEventsDlq`, como
  na AWS. Os SLOs nativos (Application Signals) existem só no deploy da AWS.
- 🧠 **Recursos**: memória (`MemoryUsedMB`) das Lambdas `local-*` (criadas com o
  `FunctionMemoryMB` do `template.yaml`) e do processo do `local-server`, que
  roda todos os outros handlers e por isso não tem limite. O custo é só
  estimado, a partir de `InvocationDurationMs`: o LocalStack não tem Cost
  Explorer e não publica o consumo do DynamoDB, que fica de fora.

Logs e Rastreio leem um buffer em memória (últimas 2000 linhas, desde que o
servidor subiu, mais a última hora das Lambdas); na AWS, do CloudWatch Logs.

O CloudWatch (e o SNS, para conferir os avisos dos alarmes) precisa estar em `SERVICES` no `docker-compose.yml`. Se o
container subiu antes dessa mudança, recrie-o (apaga os dados locais):
`npm run localstack:stop && npm run localstack:start`, depois o deploy e o seed de novo.

## Dashboard

O `local-server.mjs` faz o papel do API Gateway: chama os handlers reais dos
serviços. A compra roda na state machine `local-purchase-saga`, publicada por
`npm run localstack:deploy`. Se ela não existir, o servidor avisa e as compras
respondem 503.

A primeira compra depois de um deploy pode levar de 10 a 20 segundos: cada
Lambda sobe um container no LocalStack na primeira invocação (*cold start*). As
seguintes são rápidas.

## Variáveis de ambiente

| Variável | Uso | Padrão |
|---|---|---|
| `DYNAMODB_ENDPOINT` / `AWS_ENDPOINT` | Endpoint local do DynamoDB (sem ela, usa a AWS) | — |
| `STEPFUNCTIONS_ENDPOINT`, `EVENTBRIDGE_ENDPOINT` | Endpoints locais (caem em `AWS_ENDPOINT`) | — |
| `PRODUCTS_TABLE`, `ORDERS_TABLE`, `PAYMENTS_TABLE`, `STOCK_RESERVATIONS_TABLE`, `INVENTORY_TABLE`, `SAGAS_TABLE` | Nomes das tabelas | `products`, `orders`, `payments`, `stock-reservations`, `inventory`, `sagas` |
| `PRODUCT_FUNCTION_NAME` | Lambda de produtos consultada pela saga ao iniciar | `local-ProductFunction` (local-server) |
| `SAGA_STATE_MACHINE_ARN` | State machine da saga | — |
| `EVENT_BUS_NAME` | Barramento de eventos (sem ele, os eventos vão para o log e para assinantes locais, ex.: `ProductCreated` → Stock) | — |
| `TIMEOUT_SCALE` | Multiplica os timeouts do SDK (conexão, request, Scan, Lambda de produtos). Ligado sozinho com `AWS_ENDPOINT` ou `LOCALSTACK_HOSTNAME` (o LocalStack sobrecarregado não responde nos tempos da AWS); o breaker de produtos passa a abrir com 10 falhas e testar a volta em 10s. `1` desliga. Na AWS nenhuma dessas variáveis existe | `3` no LocalStack, `1` na AWS |
| `PAYMENT_MAX_AMOUNT` | Valor máximo aprovado pelo pagamento simulado | `10000` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` ou `silent` | `info` (`warn` no `local-server`) |
| `CORS_ALLOW_ORIGIN` | Origem do header `Access-Control-Allow-Origin`. No `local-server` só é enviado se definida (o dashboard é servido pelo próprio servidor, na mesma origem); em invocações diretas o padrão é `*` (na AWS vale o parâmetro `AllowedOrigin`) | — no `local-server` |
| `ADMIN_API_KEY_HASH` | Hash scrypt da chave de admin do `local-server`, gerado por `npm run admin:hash` (tem prioridade sobre `ADMIN_API_KEY`) | — |
| `HOST`, `PORT` | Endereço do `local-server` (`HOST=0.0.0.0` exige a chave de admin) | `127.0.0.1`, `3001` |
| `LOCALSTACK_ENDPOINT` | Endpoint usado pelo `test:e2e` | `http://localhost:4566` |

O arquivo `.env.test` tem os valores para o LocalStack:
`set -a; source .env.test; set +a`.

## Comandos úteis

```bash
aws --endpoint-url http://localhost:4566 dynamodb list-tables
aws --endpoint-url http://localhost:4566 dynamodb scan --table-name products
aws --endpoint-url http://localhost:4566 stepfunctions list-state-machines
docker compose logs -f localstack
```

## Problemas comuns

**Porta 4566 em uso:** `lsof -i :4566` e pare o processo ou o container antigo.

**`LocalStack requires an auth token` / container sai logo ao iniciar:** a
imagem não é a 4.14.0. Confira o `docker-compose.yml`.

**Lambdas não executam no LocalStack:** confirme que `/var/run/docker.sock` está
montado (veja `docker-compose.yml`). A primeira execução baixa a imagem do
runtime e pode demorar.
