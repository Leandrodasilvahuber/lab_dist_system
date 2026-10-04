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

# 2. Cria as tabelas (products, orders, payments, stock-reservations, inventory, sagas) e popula catálogo e estoque
npm run seed:local

# 3. Publica as Lambdas e a saga no LocalStack e abre o dashboard
npm run build              # empacota as Lambdas
npm run localstack:deploy  # repita depois de mudar o código (após npm run build)
npm run local-server       # http://localhost:3001

# 4. Testes contra o LocalStack
npm run test:integration   # SDKs contra o DynamoDB
npm run test:e2e           # saga completa: Lambda + Step Functions + DynamoDB
npm run test:e2e:errors    # provoca erros tratados/não tratados e cria alarmes locais

# 5. Para tudo
npm run localstack:stop
```

Com a saga publicada, cada subida do `local-server` envia 4 compras de exemplo
(apple, banana, grape e server; a do server tem o pagamento recusado e termina em
compensação). As chaves de idempotência são fixas, então elas só viram pedidos
novos enquanto essas sagas não existem na tabela Sagas do LocalStack: na 1ª
subida após o deploy ou depois de recriar o LocalStack. Para não enviá-las, use
`SAMPLE_ORDERS=false npm run local-server`.

O `test:e2e` cria funções, tabelas e a state machine com um prefixo próprio
(`e2e-<timestamp>`), roda os cenários de compra e remove tudo ao final, sem
interferir nos dados do seed.

## Ver erros e alarmes

`npm run test:e2e:errors` provoca cada tipo de erro com os handlers reais e
mostra as linhas de log geradas:

| Cenário | Resultado | Log |
|---|---|---|
| `POST /products` com preço 0 | 400 | `warn API_REJECTED` |
| Ação `confirmOrder` de pedido inexistente | lança `NotFound` | `warn ACTION_REJECTED` |
| `ProductCreated` com `initialStock: -1` | evento confirmado, **sem DLQ** | `warn DOMAIN_EVENT_REJECTED` |
| `ProductCreated` sem a tabela de inventário | 3 tentativas e depois DLQ `local-ProductEventsDlq` | `error ACTION_FAILED` + stack |
| `GET /stock` sem a tabela de inventário | 500 sem detalhes | `error UNEXPECTED_ERROR` + stack |

No fim, ele cria os alarmes `local-ecommerce-*` (os mesmos do `template.yaml`)
no CloudWatch do LocalStack e espera o LocalStack avaliá-los. Como o LocalStack
não aplica metric filters nem publica métricas de SQS/API Gateway/Step
Functions, o script publica em `Ecommerce/local` os valores observados (erros
`error` no log, mensagens na DLQ, respostas 5xx). Os alarmes locais usam
período de 60 s e ficam ~15 min em ALARM. Abra `npm run local-server` → aba
🩺 Monitoramento para ver a tabela. Para apagar alarmes e DLQ:
`npm run test:e2e:errors -- --cleanup`.

A aba 📭 **DLQ** lista os eventos que o teste deixou na `local-ProductEventsDlq`
(o `ProductCreated` de `p-transitorio`). ♻️ Reprocessar entrega o evento de novo
ao Stock (cria o item "Transitório" no estoque local); 🗑️ Descartar só apaga.

A aba 📜 **Logs** mostra as linhas warn/error. No `local-server` elas vêm de um
buffer em memória (últimas 500, desde que o servidor subiu); na AWS, do
CloudWatch Logs. Exige a chave de admin quando `ADMIN_API_KEY` está definida.

O CloudWatch precisa estar em `SERVICES` no `docker-compose.yml`. Se o
container subiu antes dessa mudança, recrie-o (apaga os dados locais):
`npm run localstack:stop && npm run localstack:start && npm run seed:local`.

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
| `PAYMENT_MAX_AMOUNT` | Valor máximo aprovado pelo pagamento simulado | `10000` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` ou `silent` | `info` (`warn` no `local-server`) |
| `SAMPLE_ORDERS` | `false` desliga as compras de exemplo enviadas ao subir o `local-server` | ligado |
| `CORS_ALLOW_ORIGIN` | Origem do header `Access-Control-Allow-Origin` no `local-server` e em invocações diretas (na AWS vale o parâmetro `AllowedOrigin`) | `*` |
| `HOST`, `PORT` | Endereço do `local-server` (`HOST=0.0.0.0` exige `ADMIN_API_KEY`) | `127.0.0.1`, `3001` |
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
