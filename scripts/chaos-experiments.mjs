#!/usr/bin/env node
/**
 * Experimentos de caos: para cada experimento (dashboard/js/services/chaos-presets.js)
 *  1. registra a hipótese e o estoque do produto;
 *  2. liga as falhas (PUT /chaos) e espera o cache das Lambdas (CHAOS_CACHE_TTL_MS);
 *  3. dispara N compras pela API, como o dashboard;
 *  4. verifica a hipótese: status final das sagas (ou 503 com Retry-After) e,
 *     ao fim, a invariante do estoque (disponível = antes - vendidos, sem reserva ativa);
 *  5. desliga o caos (DELETE /chaos), mesmo se algo falhar.
 *
 * Fala só com a API HTTP (local-server ou API Gateway): não lê tabela de
 * nenhum serviço. A injeção em si está em src/common/chaos.mjs.
 *
 * Pré-requisitos (local): npm run localstack:start (com ssm em SERVICES),
 * npm run build && npm run localstack:deploy, npm run seed:local, npm run local-server
 *
 * Uso:
 *   npm run chaos                                 # todos (os awsOnly só contra a AWS)
 *   npm run chaos -- payment-down refund-flaky    # só estes
 *   npm run chaos -- --api https://xxx.execute-api.us-east-1.amazonaws.com --orders 6
 *   npm run chaos -- --product <id>               # produto usado nas compras
 * Chave de admin (PUT/DELETE /chaos e POST /products): variável ADMIN_API_KEY.
 */
import { randomUUID } from 'node:crypto';
import { CHAOS_PRESETS } from '../dashboard/js/services/chaos-presets.js';
import { CHAOS_CACHE_TTL_MS } from '../src/common/chaos.mjs';
import { mapLimit } from './lib/pool.mjs';
import { LOCAL_MAX_CONCURRENCY } from './lib/localstack.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const optionValues = new Set(['--api', '--orders', '--product'].flatMap(name => {
  const index = args.indexOf(name);
  return index === -1 ? [] : [args[index + 1]];
}));
const selected = args.filter(a => !a.startsWith('--') && !optionValues.has(a));

const API = (option('api', process.env.CHAOS_API || 'http://localhost:3001')).replace(/\/$/, '');
const ORDERS = Number(option('orders', 6));
const IS_LOCAL = /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(`${API}/`);
// Local: cada passo pode levar até 30 s e a execução até ~20 min no pior caso
const SAGA_TIMEOUT_MS = (IS_LOCAL ? 15 : 5) * 60 * 1000;
const DLQ_TIMEOUT_MS = 10 * 60 * 1000;
const CONCURRENCY = IS_LOCAL ? LOCAL_MAX_CONCURRENCY : 4;
// Folga sobre o cache da config nas Lambdas: depois disso todas já leram a nova
const PROPAGATION_MS = CHAOS_CACHE_TTL_MS + 2000;
const CHAOS_MINUTES = 30;

const out = console.log.bind(console);
const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const ok = text => color(32, text);
const bad = text => color(31, text);
const dim = text => color(2, text);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.ADMIN_API_KEY && { 'X-Api-Key': process.env.ADMIN_API_KEY }),
      ...headers
    },
    ...(body !== undefined && { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, retryAfter: response.headers.get('retry-after'), data };
}

async function must(path, options) {
  const result = await request(path, options);
  if (result.status >= 400) throw new Error(`${options?.method || 'GET'} ${path} -> ${result.status}: ${result.data.error || ''}`);
  return result.data;
}

async function setChaos(faults) {
  const expiresAt = new Date(Date.now() + CHAOS_MINUTES * 60 * 1000).toISOString();
  await must('/chaos', { method: 'PUT', body: { expiresAt, faults } });
  await sleep(PROPAGATION_MS);
}

async function clearChaos() {
  await must('/chaos', { method: 'DELETE' });
  await sleep(PROPAGATION_MS);
}

async function stockOf(productId) {
  const { available, reserved } = await must(`/stock/${encodeURIComponent(productId)}`);
  return { available, reserved };
}

async function pickProduct() {
  const wanted = option('product');
  const { stock = [] } = await must('/stock?limit=100');
  const candidates = stock.filter(item => (wanted ? item.productId === wanted : item.available >= ORDERS));
  if (!candidates.length) {
    throw new Error(wanted ? `Produto ${wanted} sem inventário` : `Nenhum produto com estoque >= ${ORDERS} (rode npm run seed:local)`);
  }
  return candidates.sort((a, b) => b.available - a.available)[0].productId;
}

async function purchase(productId, experiment) {
  const correlationId = `chaos-${experiment}-${randomUUID().slice(0, 8)}`;
  const result = await request('/saga/execute', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID(), 'X-Correlation-Id': correlationId },
    body: { productId, quantity: 1 }
  });
  return { correlationId, ...result };
}

async function waitFinal(sagaId) {
  const deadline = Date.now() + SAGA_TIMEOUT_MS;
  let delay = 1000;
  while (Date.now() < deadline) {
    const { status, data } = await request(`/saga/${encodeURIComponent(sagaId)}`);
    if (status === 200 && !['RUNNING', 'COMPENSATING'].includes(data.status)) return data.status;
    await sleep(delay);
    delay = Math.min(delay * 2, 10000);
  }
  return 'TIMEOUT';
}

// Evidência de que a falha foi sorteada: linha CHAOS_INJECTED no rastreio da
// compra. Na AWS os logs chegam com atraso, então a ausência não reprova
async function injectedCount(correlationIds) {
  let count = 0;
  for (const id of correlationIds) {
    const { data } = await request(`/trace/${encodeURIComponent(id)}`);
    count += (data.logs || []).filter(line => line.event === 'CHAOS_INJECTED').length;
  }
  return count;
}

async function runSagaExperiment(preset, productId) {
  const before = await stockOf(productId);
  const checks = [];
  let completed = 0;
  let evidence = 0;

  const orders = Math.max(ORDERS, preset.orders ?? 0);
  await setChaos(preset.faults);
  let purchases;
  try {
    purchases = await mapLimit(Array.from({ length: orders }), preset.sequential ? 1 : CONCURRENCY, () => purchase(productId, preset.id));

    if (preset.expect === 'REJECTED') {
      const rejected = purchases.filter(p => p.status === 503 && p.retryAfter);
      checks.push([`${rejected.length}/${orders} compras recusadas com 503 + Retry-After`, rejected.length === orders]);
      checks.push(['nenhuma saga criada', purchases.every(p => !p.data.sagaId)]);
      // Recusa do breaker aberto: "<nome> unavailable (circuit open)", sem invocar Products
      const byCircuit = rejected.filter(p => /circuit open/.test(p.data.error || '')).length;
      checks.push([`circuito aberto: ${byCircuit} recusa(s) sem invocar Products, ${rejected.length - byCircuit} por falha da invocação`, byCircuit > 0]);
    } else {
      const started = purchases.filter(p => p.status === 202 && p.data.sagaId);
      checks.push([`${started.length}/${orders} compras iniciadas (202)`, started.length === orders]);
      const finals = await Promise.all(started.map(p => waitFinal(p.data.sagaId)));
      const tally = finals.reduce((acc, s) => ({ ...acc, [s]: (acc[s] || 0) + 1 }), {});
      completed = tally.COMPLETED || 0;
      checks.push([`status finais ${JSON.stringify(tally)} (esperado: todas ${preset.expect})`, finals.every(s => s === preset.expect)]);
      checks.push(['nenhuma COMPENSATION_FAILED', !tally.COMPENSATION_FAILED]);
    }
  } finally {
    await clearChaos();
  }
  // Depois da espera do clearChaos: os logs das Lambdas chegam ao rastreio com atraso
  evidence = await injectedCount(purchases.map(p => p.correlationId));

  // Depois de desligar: o sistema volta ao normal (o circuit breaker fecha no half-open)
  if (preset.expect === 'REJECTED') {
    await sleep(IS_LOCAL ? 11000 : 31000);
    const recovery = await purchase(productId, `${preset.id}-recovery`);
    const final = recovery.data.sagaId ? await waitFinal(recovery.data.sagaId) : `HTTP ${recovery.status}`;
    completed += final === 'COMPLETED' ? 1 : 0;
    checks.push([`após desligar, nova compra conclui (${final})`, final === 'COMPLETED']);
  }

  const after = await stockOf(productId);
  checks.push([
    `estoque ${before.available} -> ${after.available} (esperado ${before.available - completed}), reservas ativas ${after.reserved ?? '?'}`,
    after.available === before.available - completed && !after.reserved
  ]);
  return { checks, evidence };
}

async function runDlqExperiment(preset) {
  const checks = [];
  const name = `chaos-dlq-${Date.now()}`;
  let productId;
  let entry;

  await setChaos(preset.faults);
  try {
    const created = await must('/products', { method: 'POST', body: { name, price: 1, stock: 5 } });
    productId = created.id || created.product?.id;
    const deadline = Date.now() + DLQ_TIMEOUT_MS;
    while (!entry && Date.now() < deadline) {
      await sleep(15000);
      const { messages = [] } = await must('/dlq');
      entry = messages.find(m => m.detail?.productId === productId);
    }
    checks.push([`ProductCreated de ${productId} na DLQ`, Boolean(entry)]);
  } finally {
    await clearChaos();
  }

  if (entry) {
    await must(`/dlq/${encodeURIComponent(entry.messageId)}/redrive`, { method: 'POST' });
    await sleep(10000);
    const { status } = await request(`/stock/${encodeURIComponent(productId)}`);
    checks.push(['após desligar e reprocessar, o inventário existe', status === 200]);
  }
  if (productId) await request(`/products/${encodeURIComponent(productId)}`, { method: 'DELETE' });
  return { checks, evidence: entry ? 1 : 0 };
}

// ---------- Execução ----------
const presets = CHAOS_PRESETS.filter(p => !selected.length || selected.includes(p.id));
const unknown = selected.filter(id => !CHAOS_PRESETS.some(p => p.id === id));
if (unknown.length) {
  out(bad(`Experimento(s) desconhecido(s): ${unknown.join(', ')}. Disponíveis: ${CHAOS_PRESETS.map(p => p.id).join(', ')}`));
  process.exit(2);
}

let state;
try {
  state = await must('/chaos');
} catch (error) {
  out(bad(`API ${API} indisponível ou sem /chaos: ${error.message}`));
  process.exit(1);
}
if (!state.enabled) {
  out(bad('Injeção de falhas desligada neste ambiente (CHAOS_ENABLED=false).'));
  process.exit(1);
}

// Ctrl+C no meio de um experimento: não deixa o caos ligado
process.on('SIGINT', async () => {
  out(dim('\nInterrompido: desligando o caos...'));
  await request('/chaos', { method: 'DELETE' }).catch(() => {});
  process.exit(130);
});

const productId = await pickProduct();
out(`API: ${API} · ${ORDERS} compra(s) por experimento · produto ${productId}\n`);

const results = [];
for (const preset of presets) {
  if (preset.awsOnly && IS_LOCAL) {
    out(dim(`⏭  ${preset.id}: só na AWS (localmente não há EventBridge nem DLQ)\n`));
    results.push({ id: preset.id, skipped: true });
    continue;
  }
  out(`🧪 ${preset.label} (${preset.id})`);
  out(dim(`   Hipótese: ${preset.hypothesis}`));
  let result;
  try {
    result = preset.expect === 'DLQ' ? await runDlqExperiment(preset) : await runSagaExperiment(preset, productId);
  } catch (error) {
    result = { checks: [[`erro ao executar: ${error.message}`, false]], evidence: 0 };
  }
  for (const [label, passed] of result.checks) out(`   ${passed ? ok('✔') : bad('✘')} ${label}`);
  out(dim(`   falhas injetadas vistas no rastreio: ${result.evidence}${result.evidence ? '' : ' (nenhuma: a falha pode não ter sido sorteada ou o log ainda não chegou)'}`));
  const passed = result.checks.every(([, p]) => p);
  out(`   ${passed ? ok('Hipótese confirmada') : bad('Hipótese refutada')}\n`);
  results.push({ id: preset.id, passed });
}

const failed = results.filter(r => !r.skipped && !r.passed);
out(failed.length
  ? bad(`${failed.length} experimento(s) refutado(s): ${failed.map(r => r.id).join(', ')}`)
  : ok(`Todos os ${results.filter(r => !r.skipped).length} experimento(s) confirmaram a hipótese`));
process.exit(failed.length ? 1 : 0);
