#!/usr/bin/env python3
"""
Gera src/ecommerce/saga-orchestrator/workflow/saga-workflow.asl.json

Fluxo:  CreateOrder -> ReserveStock -> ProcessPayment -> CommitReservation -> ConfirmOrder
Falha:  compensa, em ordem reversa, os passos já concluídos E o próprio passo
        que falhou (RefundPayment -> ReleaseStock -> CancelOrder)

O estoque é reservado antes da cobrança: falta de estoque (a falha mais comum)
não gera cobrança seguida de reembolso.

A compensação começa no passo que falhou porque uma falha vista pelo Step
Functions (timeout, erro de rede) não garante que o passo não gravou nada.
As compensações são idempotentes e tratam "nunca foi gravado" como nada a
desfazer (gravando um registro anulado para barrar uma escrita atrasada).

Uma compensação que falha (mesmo após as tentativas) é registrada e a cadeia
segue para as próximas: cada uma desfaz um serviço diferente, então um
reembolso que falhou não deve deixar o estoque preso. No fim, se alguma
falhou, a saga termina em COMPENSATION_FAILED (intervenção manual).

Cada passo é registrado na tabela de sagas (steps.<nome>) via integração
direta do Step Functions com o DynamoDB, sem Lambda extra.

Uso: python3 scripts/generate-saga-workflow.py
"""
import json
import os

# Erros transitórios: vale repetir. Erros de negócio (InsufficientStock,
# PaymentDeclined, NotFound...) não são repetidos e vão direto para a compensação.
TRANSIENT_ERRORS = [
    'Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException',
    'Lambda.TooManyRequestsException', 'States.Timeout',
    'ThrottlingException', 'ProvisionedThroughputExceededException',
    'TransactionConflictException', 'InternalServerError', 'ServiceUnavailable',
    # Timeout/erro da própria Lambda: os passos são idempotentes, repetir é seguro
    'Sandbox.Timedout', 'Lambda.Unknown'
]

# Backoff exponencial com jitter completo e teto: sagas simultâneas no mesmo
# produto (TransactionConflict) não repetem em sincronia e voltam a colidir
BACKOFF = {'IntervalSeconds': 1, 'BackoffRate': 2, 'MaxDelaySeconds': 10, 'JitterStrategy': 'FULL'}

# Prazo da compra: conclui ou é desfeita em ~5 min no pior caso.
# Cada passo é uma escrita no DynamoDB (milissegundos); passar de 5 s vira
# States.Timeout, que é repetido (TRANSIENT_ERRORS) e depois compensado como
# qualquer falha. Os passos são idempotentes, então a chamada abandonada que
# ainda terminar não duplica nada. Pior caso, com o backoff no teto do jitter:
#   ida:          5 passos x (4 tentativas x 5 s + 1+2+4 s)       ~ 2,5 min
#   compensação:  3 passos x (6 tentativas x 5 s + 1+2+4+8+10 s)  ~ 2,5 min
# O teto da execução fica bem acima disso: quando ele estoura o Step Functions
# encerra a execução SEM rodar compensação, então é só rede de segurança (entra
# no alarme saga-failed como ExecutionsTimedOut e o reconciliador do
# SagaService marca a saga como COMPENSATION_FAILED, intervenção manual).
# No LocalStack o passo espera até o timeout da Lambda local (30 s: lá o cold
# start sobe um contêiner) e o teto sobe junto (scripts/lib/localstack.mjs).
STEP_TIMEOUT_SECONDS = 5
EXECUTION_TIMEOUT_SECONDS = 600

FUNCTIONS = {'orders': '${OrderFunctionArn}', 'payments': '${PaymentFunctionArn}', 'stock': '${StockFunctionArn}'}
TABLE = '${SagasTableName}'

FORWARD = [
    # (estado, serviço, ação, input, ResultSelector, ResultPath)
    ('CreateOrder', 'orders', 'createOrder',
     {'orderId.$': '$.ids.orderId', 'productId.$': '$.productId', 'quantity.$': '$.quantity',
      'unitPrice.$': '$.unitPrice', 'correlationId.$': '$.correlationId'},
     {'id.$': '$.Payload.id', 'total.$': '$.Payload.total'}, '$.order'),
    ('ReserveStock', 'stock', 'reserveStock',
     {'reservationId.$': '$.ids.reservationId', 'productId.$': '$.productId', 'quantity.$': '$.quantity', 'correlationId.$': '$.correlationId'},
     {'id.$': '$.Payload.id'}, '$.reservation'),
    ('ProcessPayment', 'payments', 'processPayment',
     {'paymentId.$': '$.ids.paymentId', 'orderId.$': '$.ids.orderId', 'amount.$': '$.order.total', 'correlationId.$': '$.correlationId'},
     {'id.$': '$.Payload.id', 'status.$': '$.Payload.status'}, '$.payment'),
    ('CommitReservation', 'stock', 'commitReservation',
     {'reservationId.$': '$.ids.reservationId', 'correlationId.$': '$.correlationId'},
     None, None),
    ('ConfirmOrder', 'orders', 'confirmOrder',
     {'orderId.$': '$.ids.orderId', 'correlationId.$': '$.correlationId'},
     None, None),
]

# Compensação de cada passo (na ordem reversa de execução)
COMPENSATIONS = [
    ('RefundPayment', 'payments', 'refundPayment', {'paymentId.$': '$.ids.paymentId', 'correlationId.$': '$.correlationId'}),
    ('ReleaseStock', 'stock', 'releaseStock', {'reservationId.$': '$.ids.reservationId', 'correlationId.$': '$.correlationId'}),
    ('CancelOrder', 'orders', 'cancelOrder', {'orderId.$': '$.ids.orderId', 'correlationId.$': '$.correlationId'}),
]

# Se o passo X falhar, a compensação começa em... (o próprio passo X incluído)
COMPENSATION_ENTRY = {
    'CreateOrder': None,             # tratado à parte: limpa o pedido e termina em FAILED
    'ReserveStock': 'ReleaseStock',
    'ProcessPayment': 'RefundPayment',
    'CommitReservation': 'RefundPayment',
    'ConfirmOrder': 'RefundPayment',
}


def camel(name):
    return name[0].lower() + name[1:]


def lambda_task(service, action, payload_input, next_state, retry_attempts, catch_next):
    return {
        'Type': 'Task',
        'Resource': 'arn:aws:states:::lambda:invoke',
        'Parameters': {
            'FunctionName': FUNCTIONS[service],
            'Payload': {'action': action, 'input': payload_input}
        },
        'TimeoutSeconds': STEP_TIMEOUT_SECONDS,
        'Retry': [{
            'ErrorEquals': TRANSIENT_ERRORS,
            'MaxAttempts': retry_attempts,
            **BACKOFF
        }],
        'Catch': [{'ErrorEquals': ['States.ALL'], 'ResultPath': '$.error', 'Next': catch_next}],
        'Next': next_state
    }


def update_saga(update_expression, names, values, next_state):
    """Atualiza o registro da saga. Falha ao registrar não interrompe o fluxo."""
    return {
        'Type': 'Task',
        'Resource': 'arn:aws:states:::dynamodb:updateItem',
        'Parameters': {
            'TableName': TABLE,
            'Key': {'id': {'S.$': '$.sagaId'}},
            'UpdateExpression': update_expression,
            **({'ExpressionAttributeNames': names} if names else {}),
            'ExpressionAttributeValues': values
        },
        'ResultPath': None,
        'Retry': [{'ErrorEquals': ['States.ALL'], 'MaxAttempts': 3, **BACKOFF}],
        'Catch': [{'ErrorEquals': ['States.ALL'], 'ResultPath': '$.recordError', 'Next': next_state}],
        'Next': next_state
    }


def record_step(step_name, status, next_state, error_path=None):
    step_value = {'status': {'S': status}, 'at': {'S.$': '$$.State.EnteredTime'}}
    values = {':now': {'S.$': '$$.State.EnteredTime'}}
    expression = 'SET steps.#step = :step, updatedAt = :now'
    if error_path:
        step_value['error'] = {'S.$': f'{error_path}.Error'}
        step_value['cause'] = {'S.$': f'States.JsonToString({error_path})'}
    values[':step'] = {'M': step_value}
    return update_saga(expression, {'#step': step_name}, values, next_state)


def set_status(status, next_state, failed_step=None, remove_error=False):
    values = {':status': {'S': status}, ':now': {'S.$': '$$.State.EnteredTime'}}
    expression = 'SET #status = :status, updatedAt = :now'
    if remove_error:
        # Erro deixado por uma tentativa de início dada como falha (StartExecutionFailed)
        expression += ' REMOVE #error, errorCause'
    if failed_step:
        values[':failedStep'] = {'S': failed_step}
        values[':error'] = {'S.$': '$.error.Error'}
        values[':cause'] = {'S.$': 'States.JsonToString($.error)'}
        expression += ', failedStep = :failedStep, #error = :error, errorCause = :cause'
    names = {'#status': 'status'}
    if failed_step or remove_error:
        names['#error'] = 'error'
    return update_saga(expression, names, values, next_state)


states = {}

# Passos de ida
for i, (state, service, action, payload, selector, result_path) in enumerate(FORWARD):
    record_ok = f'Record{state}'
    on_fail = f'Record{state}Failed'
    next_forward = FORWARD[i + 1][0] if i + 1 < len(FORWARD) else 'MarkCompleted'

    task = lambda_task(service, action, payload, record_ok, 3, on_fail)
    if selector:
        task['ResultSelector'] = selector
    task['ResultPath'] = result_path
    states[state] = task
    states[record_ok] = record_step(camel(state), 'COMPLETED', next_forward)

    entry = COMPENSATION_ENTRY[state]
    if entry:
        states[on_fail] = record_step(camel(state), 'FAILED', f'MarkCompensating{state}', error_path='$.error')
        states[f'MarkCompensating{state}'] = set_status('COMPENSATING', entry, failed_step=camel(state))
    else:
        states[on_fail] = record_step(camel(state), 'FAILED', 'CleanupOrder', error_path='$.error')

states['MarkCompleted'] = set_status('COMPLETED', 'SagaCompleted', remove_error=True)
states['SagaCompleted'] = {'Type': 'Succeed'}

# Cadeia de compensação (compartilhada; cada falha entra no ponto certo).
# A falha de uma compensação vai para $.compensationError e a cadeia continua.
for i, (state, service, action, payload) in enumerate(COMPENSATIONS):
    record = f'Record{state}'
    record_failed = f'Record{state}Failed'
    next_comp = COMPENSATIONS[i + 1][0] if i + 1 < len(COMPENSATIONS) else 'CheckCompensations'
    task = lambda_task(service, action, payload, record, 5, record_failed)
    task['Catch'][0]['ResultPath'] = '$.compensationError'
    task['ResultPath'] = None
    states[state] = task
    states[record] = record_step(camel(state), 'COMPENSATED', next_comp)
    states[record_failed] = record_step(camel(state), 'COMPENSATION_FAILED', next_comp, error_path='$.compensationError')

states['CheckCompensations'] = {
    'Type': 'Choice',
    'Choices': [{'Variable': '$.compensationError', 'IsPresent': True, 'Next': 'MarkCompensationFailed'}],
    'Default': 'MarkCompensated'
}
states['MarkCompensated'] = set_status('COMPENSATED', 'SagaCompensated')
states['SagaCompensated'] = {'Type': 'Fail', 'Error': 'SagaCompensated', 'Cause': 'A step failed and all completed steps were compensated'}

# Falha no primeiro passo: o pedido pode ter sido gravado mesmo assim
# (ex.: timeout depois da escrita). Cancela, se existir, e termina em FAILED.
cleanup = lambda_task('orders', 'cancelOrder', COMPENSATIONS[-1][3], 'MarkFailed', 5, 'MarkCompensationFailed')
cleanup['Catch'][0]['ResultPath'] = '$.compensationError'
cleanup['ResultPath'] = None
states['CleanupOrder'] = cleanup

failed_values = {
    ':status': {'S': 'FAILED'}, ':now': {'S.$': '$$.State.EnteredTime'}, ':failedStep': {'S': 'createOrder'},
    ':error': {'S.$': '$.error.Error'}, ':cause': {'S.$': 'States.JsonToString($.error)'}
}
states['MarkFailed'] = update_saga(
    'SET #status = :status, updatedAt = :now, failedStep = :failedStep, #error = :error, errorCause = :cause',
    {'#status': 'status', '#error': 'error'}, failed_values, 'SagaFailed')
states['SagaFailed'] = {'Type': 'Fail', 'Error': 'SagaFailed', 'Cause': 'The first step failed; the order was cleaned up'}

# Alguma compensação falhou mesmo após as tentativas: exige intervenção manual.
# Guarda a última falha; cada passo tem a sua em steps.<nome>.
states['MarkCompensationFailed'] = update_saga(
    'SET #status = :status, updatedAt = :now, compensationError = :error, compensationCause = :cause',
    {'#status': 'status'},
    {':status': {'S': 'COMPENSATION_FAILED'}, ':now': {'S.$': '$$.State.EnteredTime'},
     ':error': {'S.$': '$.compensationError.Error'}, ':cause': {'S.$': 'States.JsonToString($.compensationError)'}},
    'CompensationFailed')
states['CompensationFailed'] = {'Type': 'Fail', 'Error': 'CompensationFailed', 'Cause': 'Compensation failed; manual intervention required'}

definition = {
    'Comment': 'Saga de compra: pedido -> estoque -> pagamento -> baixa da reserva -> confirmação, com compensação. '
               'Gerado por scripts/generate-saga-workflow.py - não edite à mão.',
    'StartAt': FORWARD[0][0],
    'TimeoutSeconds': EXECUTION_TIMEOUT_SECONDS,
    'States': states
}

out = os.path.join(os.path.dirname(__file__), '..', 'src', 'ecommerce', 'saga-orchestrator', 'workflow', 'saga-workflow.asl.json')
with open(out, 'w') as f:
    json.dump(definition, f, indent=2, ensure_ascii=False)
    f.write('\n')
print(f'{len(states)} states -> {os.path.normpath(out)}')
