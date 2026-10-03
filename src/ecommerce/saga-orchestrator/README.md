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
| `src/services/ProductClient.js` | Consulta o produto invocando a Lambda de Products (`getProduct`); a saga não lê a tabela de produtos |
| `src/services/StepFunctionsClient.js` | `StartExecution` no Step Functions |
| `src/controllers/SagaOrchestratorController.js` | Rotas HTTP `/saga/execute`, `/saga/{id}`, `/sagas` |
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
`cancelOrder` ignora pedido inexistente; `refundPayment` ignora pagamento
recusado e grava `voided` se o pagamento não existe; `releaseStock` grava a
reserva como `released` se ela não existe. Os registros anulados barram um
`processPayment`/`reserveStock` atrasado com o mesmo id (`InvalidState`).

Se uma compensação falhar mesmo após as tentativas, a saga termina em
`COMPENSATION_FAILED` e precisa de intervenção manual.

## Garantias

- **Idempotência:** os ids de pedido, pagamento e reserva são derivados do
  `sagaId` (`order_<sagaId>`, `pay_<sagaId>`, `res_<sagaId>`) e gravados com
  escrita condicional. Repetir um passo devolve o resultado já existente.
  Compensar duas vezes também não tem efeito colateral.
- **Retry só para falhas transitórias:** erros e timeouts da Lambda
  (`Sandbox.Timedout`, `Lambda.Unknown`), throttling e
  `TransactionConflictException` são repetidos com backoff exponencial. Erros de
  negócio (`InsufficientStock`, `PaymentDeclined`, `NotFound`, `InvalidState`)
  vão direto para a compensação: o `name` do erro lançado pelo SDK vira o
  `errorType` da Lambda, que é o que o Step Functions compara.
- **Estoque consistente:** a reserva debita o inventário (tabela do serviço de
  Stock) numa transação do DynamoDB com a condição `stock >= quantidade`, então compras simultâneas nunca deixam o
  estoque negativo.
- **Idempotency-Key:** o cliente pode mandar o header `Idempotency-Key`; a mesma
  chave sempre corresponde à mesma saga (`saga_` + SHA-256 da chave). A mesma
  chave com outro pedido responde `409`; uma saga que falhou ao iniciar é
  iniciada de novo (execução `<sagaId>-<tentativa>`).

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

(`error` e `progress` são montados pela API a partir do que está gravado.)

## Custo

No Step Functions Standard paga-se por transição de estado (cerca de
US$ 0,025 por 1.000, com 4.000 grátis por mês). Uma compra bem-sucedida usa
cerca de 10 transições (cada passo e o seu registro), e cada passo também é uma
invocação de Lambda. Para um laboratório o custo é praticamente zero. Confira os
preços atuais em https://aws.amazon.com/step-functions/pricing/.

## Testes

```bash
npm test               # inclui test/unit/saga: estrutura do workflow e SagaService
npm run test:e2e       # saga real no LocalStack (sucesso, recusa, falta de estoque,
                       # idempotência e 10 compras simultâneas)
```
