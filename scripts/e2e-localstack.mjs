#!/usr/bin/env node
/**
 * Teste ponta a ponta da saga no LocalStack (Lambda + Step Functions + DynamoDB).
 *
 * Publica as funções geradas pelo `sam build` e a state machine real
 * (workflow/saga-workflow.asl.json) e executa cenários de compra:
 * sucesso, pagamento recusado, estoque insuficiente, idempotência, concorrência
 * e compensação de um passo que nunca chegou a gravar.
 *
 * Pré-requisitos:
 *   npm run localstack:start
 *   npm run build
 *
 * Uso: npm run test:e2e
 * Cada execução usa nomes próprios (prefixo e2e-<timestamp>) e remove tudo ao final.
 * O runtime das Lambdas é o mesmo do template.yaml.
 */
import { ROOT, clients, assertBuilt, ensureTables, deploySaga, removeSaga } from './lib/localstack.mjs';

const endpoint = process.env.LOCALSTACK_ENDPOINT || 'http://localhost:4566';
const PREFIX = `e2e-${Date.now()}`;
const T = {
  PRODUCTS_TABLE: `${PREFIX}-Products`,
  ORDERS_TABLE: `${PREFIX}-Orders`,
  PAYMENTS_TABLE: `${PREFIX}-Payments`,
  STOCK_RESERVATIONS_TABLE: `${PREFIX}-StockReservations`,
  INVENTORY_TABLE: `${PREFIX}-Inventory`,
  SAGAS_TABLE: `${PREFIX}-Sagas`
};
const aws = clients(endpoint);
const teardown = () => removeSaga(aws, { prefix: PREFIX, tables: T });
let stateMachineArn;

try {
  assertBuilt();
  await ensureTables(aws, T);
  let runtime;
  ({ stateMachineArn, runtime } = await deploySaga(aws, { prefix: PREFIX, tables: T }));
  console.log(`Infra de teste criada no LocalStack (${PREFIX}, ${runtime})`);
} catch (error) {
  console.error(`Falha ao preparar o LocalStack em ${endpoint}: ${error.message}`);
  console.error('Verifique se ele está rodando (npm run localstack:start) e se rodou npm run build.');
  await teardown();
  process.exit(1);
}

// O orquestrador e as rotas HTTP rodam neste processo, apontando para o LocalStack
Object.assign(process.env, T, {
  SAGA_STATE_MACHINE_ARN: stateMachineArn,
  PRODUCT_FUNCTION_NAME: `${PREFIX}-ProductFunction`,
  AWS_ENDPOINT: endpoint,
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  LOG_LEVEL: 'silent'
});
const saga = (await import(`${ROOT}/src/ecommerce/saga-orchestrator/index.mjs`)).handler;
const products = (await import(`${ROOT}/src/ecommerce/products/index.mjs`)).handler;
const stock = (await import(`${ROOT}/src/ecommerce/stock/index.mjs`)).handler;
const orders = (await import(`${ROOT}/src/ecommerce/orders/index.mjs`)).handler;
// Sem EventBridge aqui: ProductCreated é entregue ao Stock em processo (como a regra faria na AWS)
const { eventBus } = await import(`${ROOT}/src/common/event-bus.mjs`);
eventBus.subscribe('products', 'ProductCreated', stock);
const ev = (method, path, body, headers = {}) => ({ version: '2.0', rawPath: `/dev${path}`, headers,
  requestContext: { stage: 'dev', http: { method } }, body: body && JSON.stringify(body) });
const call = async (fn, ...a) => { const r = await fn(ev(...a)); return { status: r.statusCode, body: JSON.parse(r.body) }; };

const TERMINAL = ['COMPLETED', 'COMPENSATED', 'FAILED', 'COMPENSATION_FAILED'];
async function waitSaga(id) {
  for (let i = 0; i < 120; i++) {
    const { body } = await call(saga, 'GET', `/saga/${id}`);
    if (TERMINAL.includes(body.status)) return body;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('timeout esperando saga ' + id);
}
const steps = s => ['createOrder', 'reserveStock', 'processPayment', 'commitReservation', 'confirmOrder', 'refundPayment', 'releaseStock', 'cancelOrder']
  .filter(k => s.steps?.[k]).map(k => `${k}:${s.steps[k].status}`).join(' ');
const productStock = async id => (await call(stock, 'GET', `/stock/${id}`)).body.available;
const orderStatus = async id => (await call(orders, 'GET', `/orders/${id}`)).body.status;
let failures = 0;
const check = (label, cond) => { console.log(`  ${cond ? '✔' : '✘'} ${label}`); if (!cond) failures++; };

const p = (await call(products, 'POST', '/products', { name: 'Teclado', price: 150, stock: 10 })).body;
const caro = (await call(products, 'POST', '/products', { name: 'Servidor', price: 20000, stock: 3 })).body;

console.log('\n0) Produto criado -> inventário criado pelo Stock (evento ProductCreated)');
check('catálogo não guarda estoque', p.stock === undefined);
check('inventário inicial 10', await productStock(p.id) === 10);

console.log('\n1) Compra com sucesso (2 unidades)');
let r = await call(saga, 'POST', '/saga/execute', { productId: p.id, quantity: 2 });
console.log(`  resposta imediata: ${r.status} ${JSON.stringify(r.body)}`);
check('responde 202 com status RUNNING', r.status === 202 && r.body.status === 'RUNNING');
let s = await waitSaga(r.body.sagaId);
console.log(`  final: ${s.status} | ${steps(s)}`);
check('saga COMPLETED', s.status === 'COMPLETED');
check('estoque 10 -> 8', await productStock(p.id) === 8);
check('pedido confirmado', await orderStatus(s.orderId) === 'confirmed');
check('reserva baixada (nada fica "reservado" após a compra)', (await call(stock, 'GET', `/stock/${p.id}`)).body.reserved === 0);
const order = (await call(orders, 'GET', `/orders/${s.orderId}`)).body;
check('preço vindo da saga (2 x 150 = 300)', order.unitPrice === 150 && order.total === 300);

console.log('\n2) Pagamento recusado (valor acima do limite)');
r = await call(saga, 'POST', '/saga/execute', { productId: caro.id, quantity: 1 });
s = await waitSaga(r.body.sagaId);
console.log(`  final: ${s.status} | falhou em ${s.failedStep} (${s.error?.type}: ${s.error?.message}) | ${steps(s)}`);
check('saga COMPENSATED', s.status === 'COMPENSATED');
check('falhou no pagamento, depois de reservar', s.failedStep === 'processPayment' && s.steps.reserveStock?.status === 'COMPLETED');
check('estoque liberado e pedido cancelado', s.steps.releaseStock?.status === 'COMPENSATED' && s.steps.cancelOrder?.status === 'COMPENSATED');
check('pedido cancelado', await orderStatus(s.orderId) === 'cancelled');
check('estoque devolvido (3)', await productStock(caro.id) === 3);

console.log('\n3) Estoque insuficiente (pede 50, tem 8)');
r = await call(saga, 'POST', '/saga/execute', { productId: p.id, quantity: 50 });
s = await waitSaga(r.body.sagaId);
console.log(`  final: ${s.status} | falhou em ${s.failedStep} (${s.error?.type}: ${s.error?.message}) | ${steps(s)}`);
check('saga COMPENSATED', s.status === 'COMPENSATED');
check('não chegou a cobrar (estoque é reservado antes do pagamento)', !s.steps.processPayment && !s.steps.refundPayment);
check('pedido cancelado', s.steps.cancelOrder?.status === 'COMPENSATED' && await orderStatus(s.orderId) === 'cancelled');
check('estoque continua 8', await productStock(p.id) === 8);

console.log('\n4) Produto inexistente');
r = await call(saga, 'POST', '/saga/execute', { productId: 'nao-existe', quantity: 1 });
console.log(`  ${r.status} ${JSON.stringify(r.body)}`);
check('responde 404 sem iniciar saga', r.status === 404);

console.log('\n5) Idempotency-Key (clique duplo)');
const h = { 'Idempotency-Key': 'checkout-abc-123' };
const r1 = await call(saga, 'POST', '/saga/execute', { productId: p.id, quantity: 1 }, h);
const r2 = await call(saga, 'POST', '/saga/execute', { productId: p.id, quantity: 1 }, h);
console.log(`  1ª: ${r1.status} ${r1.body.sagaId} | 2ª: ${r2.status} ${r2.body.sagaId}`);
check('mesma saga, 202 depois 200', r1.body.sagaId === r2.body.sagaId && r1.status === 202 && r2.status === 200);
await waitSaga(r1.body.sagaId);
check('estoque debitado uma vez só (8 -> 7)', await productStock(p.id) === 7);
const r3 = await call(saga, 'POST', '/saga/execute', { productId: p.id, quantity: 2 }, h);
check('mesma chave com outro pedido responde 409', r3.status === 409);

console.log('\n6) Concorrência: 10 compras simultâneas de 1 unidade, produto com 5 em estoque');
const c = (await call(products, 'POST', '/products', { name: 'Mouse', price: 80, stock: 5 })).body;
const started = await Promise.all(Array.from({ length: 10 }, () => call(saga, 'POST', '/saga/execute', { productId: c.id, quantity: 1 })));
const finals = await Promise.all(started.map(x => waitSaga(x.body.sagaId)));
const count = st => finals.filter(f => f.status === st).length;
console.log(`  COMPLETED=${count('COMPLETED')} COMPENSATED=${count('COMPENSATED')} outros=${10 - count('COMPLETED') - count('COMPENSATED')}`);
check('exatamente 5 concluídas e 5 compensadas', count('COMPLETED') === 5 && count('COMPENSATED') === 5);
check('estoque final 0 (nunca negativo)', await productStock(c.id) === 0);
const res = (await call(stock, 'GET', `/stock/${c.id}`)).body;
console.log(`  GET /stock: ${JSON.stringify(res)}`);
check('nenhuma reserva ativa depois que as compras terminam', res.activeReservations === 0 && res.reserved === 0);

console.log('\n7) Várias reservas do mesmo produto via ação interna + liberação');
// Reserva/liberação não têm rota HTTP: só a saga as invoca ({ action, input })
const action = (fn, name, input) => fn({ action: name, input });
const ra = await action(stock, 'reserveStock', { productId: p.id, quantity: 2 });
const rb = await action(stock, 'reserveStock', { productId: p.id, quantity: 3 });
check('duas reservas aceitas (7 -> 2)', ra.status === 'active' && rb.status === 'active' && await productStock(p.id) === 2);
const rel = await action(stock, 'releaseStock', { reservationId: ra.id });
const rel2 = await action(stock, 'releaseStock', { reservationId: ra.id });
check('liberação devolve ao estoque (2 -> 4) e repetir não duplica', rel.status === 'released' && rel2.status === 'released' && await productStock(p.id) === 4);
const committed = await action(stock, 'commitReservation', { reservationId: rb.id });
check('commit baixa a reserva sem mexer no estoque', committed.status === 'committed' && await productStock(p.id) === 4);

console.log('\n7b) Compensação de uma reserva que nunca foi gravada');
const ghost = await action(stock, 'releaseStock', { reservationId: 'res_fantasma' });
const late = await action(stock, 'reserveStock', { reservationId: 'res_fantasma', productId: p.id, quantity: 1 }).catch(e => e);
check('liberar o inexistente não falha', ghost.status === 'released');
check('reserva atrasada com o mesmo id é recusada', late.name === 'InvalidState' && await productStock(p.id) === 4);

console.log('\n8) Rotas operacionais não são públicas');
const reserveHttp = await call(stock, 'POST', `/stock/${p.id}/reserve`, { quantity: 1 });
const confirmHttp = await call(orders, 'POST', '/orders/confirm', { orderId: s.orderId });
check('POST /stock/{id}/reserve e /orders/confirm respondem 404', reserveHttp.status === 404 && confirmHttp.status === 404);
check('estoque intacto (4)', await productStock(p.id) === 4);

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : failures + ' VERIFICAÇÕES FALHARAM'}`);
await teardown();
process.exit(failures ? 1 : 0);
