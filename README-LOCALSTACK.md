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

# 2. Cria as tabelas (products, orders, payments, stock-reservations, sagas) e popula os produtos
npm run seed:local

# 3. Publica as Lambdas e a saga no LocalStack e abre o dashboard
npm run build              # empacota as Lambdas
npm run localstack:deploy  # repita depois de mudar o código (após npm run build)
npm run local-server       # http://localhost:3001

# 4. Testes contra o LocalStack
npm run test:integration   # SDKs contra o DynamoDB
npm run test:e2e           # saga completa: Lambda + Step Functions + DynamoDB

# 5. Para tudo
npm run localstack:stop
```

O `test:e2e` cria funções, tabelas e a state machine com um prefixo próprio
(`e2e-<timestamp>`), roda os cenários de compra e remove tudo ao final, sem
interferir nos dados do seed.

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
| `PRODUCTS_TABLE`, `ORDERS_TABLE`, `PAYMENTS_TABLE`, `STOCK_RESERVATIONS_TABLE`, `SAGAS_TABLE` | Nomes das tabelas | `products`, `orders`, `payments`, `stock-reservations`, `sagas` |
| `SAGA_STATE_MACHINE_ARN` | State machine da saga | — |
| `EVENT_BUS_NAME` | Barramento de eventos (sem ele, os eventos só vão para o log) | — |
| `PAYMENT_MAX_AMOUNT` | Valor máximo aprovado pelo pagamento simulado | `10000` |
| `LOG_LEVEL` | `info`, `error` ou `silent` | `info` |
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
