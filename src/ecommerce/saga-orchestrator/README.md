# Saga Orchestrator

Coordena a compra como uma **saga orquestrada pelo AWS Step Functions**.

## Por que orquestração com Step Functions

- **Assíncrona:** a API responde `202` na hora; pagamento e estoque podem demorar
  sem segurar uma requisição HTTP (o API Gateway corta em ~30s).
- **Durável:** o Step Functions guarda o progresso de cada passo. Se uma Lambda
  falhar no meio, ele repete ou compensa; nenhuma saga fica "presa".
- **Fluxo em um lugar só:** a sequência e a compensação ficam na definição da
  máquina de estados, visíveis como diagrama no console da AWS.

## Componentes

| Arquivo | Papel |
|---|---|
| `src/services/SagaService.js` | Valida a compra, consulta o produto, cria o registro da saga (status `RUNNING`) e inicia a execução |
| `src/common/product-client.mjs` | Consulta o produto invocando a Lambda de Products (`getProduct`); a saga não lê a tabela de produtos. Também usado pelo Stock no ajuste que cria o inventário |
| `src/services/StepFunctionsClient.js` | `StartExecution` no Step Functions |
| `src/controllers/SagaOrchestratorController.js` | Rotas HTTP `/saga/execute`, `/saga/{id}`, `/sagas` (`?recent=N`: as mais recentes das últimas 24 h, pelo índice por dia) |
| `src/common/saga-status.mjs` | Status da saga e a conversão do resultado da execução (`finalStatus`), a mesma da aba Desempenho |
| `workflow/saga-workflow.asl.json` | Máquina de estados (gerada, não edite à mão) |
| `scripts/generate-saga-workflow.py` | Gera o ASL a partir da lista de passos e compensações |

Os passos são executados pelas Lambdas dos serviços (`orders`, `payments`,
`stock`) por invocação direta: `{ "action": "reserveStock", "input": {...} }`.
Veja `src/ecommerce/*/src/actions.js`.

Antes de iniciar a execução, a saga consulta o produto (síncrono): produto
inexistente responde `404` na hora, e o preço (`unitPrice`) vai no input da
execução para o `createOrder`, congelado no momento da compra.

## Fluxo

| Passo | Serviço | Compensação |
|---|---|---|
| `createOrder` | orders | `cancelOrder` |
| `reserveStock` | stock | `releaseStock` |
| `processPayment` | payments | `refundPayment` |
| `commitReservation` | stock | (desfeito pelo `releaseStock`) |
| `confirmOrder` | orders | (desfeito pelo `cancelOrder`) |

Se o passo *N* falhar, os passos *1..N* (incluindo o que falhou) são
compensados em ordem reversa. Uma falha vista pelo Step Functions (timeout,
erro de rede) não garante que o passo não gravou nada:

| Falhou em | Compensações executadas |
|---|---|
| `createOrder` | `cancelOrder` → `FAILED` |
| `reserveStock` | `releaseStock`, `cancelOrder` → `COMPENSATED` |
| `processPayment` | `refundPayment`, `releaseStock`, `cancelOrder` → `COMPENSATED` |
| `commitReservation` | `refundPayment`, `releaseStock`, `cancelOrder` → `COMPENSATED` |
| `confirmOrder` | `refundPayment`, `releaseStock`, `cancelOrder` → `COMPENSATED` |

As compensações tratam o que nunca foi gravado como nada a desfazer:
`cancelOrder` grava `voided` se o pedido não existe; `refundPayment` ignora
pagamento recusado e grava `voided` se o pagamento não existe; `releaseStock`
grava a reserva como `released` se ela não existe. Os registros anulados barram
um `createOrder`/`processPayment`/`reserveStock` atrasado com o mesmo id
(`InvalidState`). Se o produto foi excluído durante a compra, `releaseStock`
libera a reserva sem devolver estoque (`inventoryMissing: true`).

Se uma compensação falhar mesmo após as tentativas, ela é registrada como
`COMPENSATION_FAILED` em `steps.<nome>` e as próximas rodam mesmo assim (cada uma
desfaz um serviço diferente). No fim, a saga termina em `COMPENSATION_FAILED` e
precisa de intervenção manual.

## Garantias

- **Idempotência:** os ids de pedido, pagamento e reserva são derivados do
  `sagaId` (`order_<sagaId>`, `pay_<sagaId>`, `res_<sagaId>`) e gravados com
  escrita condicional. Repetir um passo devolve o resultado já existente.
  Compensar duas vezes também não tem efeito colateral.
- **Retry só para falhas transitórias:** erros e timeouts da Lambda
  (`Sandbox.Timedout`, `Lambda.Unknown`) e `TransactionConflictException` são
  repetidos com backoff exponencial, jitter completo (`JitterStrategy: FULL`) e
  teto de 10s: sagas simultâneas no mesmo produto não repetem em sincronia.
  Throttling da Lambda (`Lambda.TooManyRequestsException`: concorrência
  esgotada num pico, ou mais de 2 compras simultâneas no LocalStack) tem retry
  próprio e mais paciente (6 tentativas, esperas de 2 a 20 s): a recusa é
  imediata e só passa quando outra invocação termina. Se mesmo assim não
  passar, o cliente vê "Service busy..." em vez do texto técnico. Erros de
  negócio (`InsufficientStock`, `PaymentDeclined`, `NotFound`, `InvalidState`)
  vão direto para a compensação: o `name` do erro lançado pelo SDK vira o
  `errorType` da Lambda, que é o que o Step Functions compara.
- **Estoque consistente:** a reserva debita o inventário (tabela do serviço de
  Stock) numa transação do DynamoDB com a condição `stock >= quantidade`, então compras simultâneas nunca deixam o
  estoque negativo.
- **Idempotency-Key:** o cliente manda o header `Idempotency-Key`
  (obrigatório); a mesma chave sempre corresponde à mesma saga (`saga_` +
  SHA-256 da chave). A mesma chave com outro pedido responde `409`; uma saga
  que falhou ao iniciar é iniciada de novo **com o mesmo nome de execução**
  (`executionName` no registro): se o `StartExecution` anterior criou a
  execução e só a resposta se perdeu (timeout), o Step Functions devolve a
  mesma execução em vez de rodar a compra duas vezes. Só se aquela execução já
  terminou vai um nome novo (`<sagaId>-<tentativa>`). Só uma falha do
  `StartExecution` conta como falha ao iniciar: se a execução começou e só a
  gravação do `executionArn` falhou, a saga segue rodando. Se a Lambda morrer
  entre gravar o registro e o `StartExecution` (a saga fica `RUNNING` sem
  execução nem passos), a mesma chave a inicia de novo depois de 60s.
- **Fail-fast ao iniciar:** a consulta ao serviço de Products tem timeout
  (5s) e circuit breaker (`src/common/circuit-breaker.mjs`, estado por
  container): com Products ou Step Functions fora do ar, `POST /saga/execute`
  responde `503` com `Retry-After`, e o cliente repete com a mesma
  `Idempotency-Key` (obrigatória).
  A abertura do circuito grava a métrica `CircuitOpened` e dispara o alarme
  `<env>-ecommerce-circuit-open`. Função de produtos inexistente ou sem
  permissão é erro de configuração: `500`, sem abrir o circuito. Throttling
  da Lambda de produtos é repetido antes, com até 5 esperas curtas (até 4,6 s
  na AWS): só depois disso vira `503`.
  Throttling, timeout ou erro 5xx de qualquer serviço da AWS também respondem
  `503` com `Retry-After` (`isTransientAwsError` em `src/common/aws-client.mjs`).

## Registro da saga (tabela Sagas)

O Step Functions atualiza o registro a cada passo (integração direta com o
DynamoDB, sem Lambda extra):

```json
{
  "id": "saga_3c1f...",
  "status": "COMPENSATED",
  "productId": "server", "quantity": 1,
  "orderId": "order_saga_3c1f...",
  "paymentId": "pay_saga_3c1f...",
  "reservationId": "res_saga_3c1f...",
  "executionArn": "arn:aws:states:...",
  "failedStep": "processPayment",
  "error": { "type": "PaymentDeclined", "message": "Payment declined: Amount exceeds limit of 10000" },
  "steps": {
    "createOrder":    { "status": "COMPLETED",   "at": "..." },
    "reserveStock":   { "status": "COMPLETED",   "at": "..." },
    "processPayment": { "status": "FAILED",      "at": "...", "error": { "type": "PaymentDeclined", "message": "..." } },
    "refundPayment":  { "status": "COMPENSATED", "at": "..." },
    "releaseStock":   { "status": "COMPENSATED", "at": "..." },
    "cancelOrder":    { "status": "COMPENSATED", "at": "..." }
  },
  "progress": { "completed": 2, "total": 5, "order": ["createOrder", "reserveStock", "processPayment", "commitReservation", "confirmOrder"] }
}
```

(`error` e `progress` são montados pela API a partir do que está gravado;
`executionArn`, `executionName`, `startAttempts` e `dayShard` ficam só na tabela,
fora da resposta de `GET /saga/{id}`.)

## Custo

No Step Functions Standard paga-se por transição de estado (cerca de
US$ 0,025 por 1.000, com 4.000 grátis por mês). Uma compra bem-sucedida usa
cerca de 12 transições (cada passo e o seu registro), e cada passo também é uma
invocação de Lambda. Para um laboratório o custo é praticamente zero. Confira os
preços atuais em https://aws.amazon.com/step-functions/pricing/.

## Testes

```bash
npm test               # inclui test/unit/saga: estrutura do workflow e SagaService
npm run test:e2e       # saga real no LocalStack (sucesso, recusa, falta de estoque,
                       # idempotência e 10 compras simultâneas)
```
