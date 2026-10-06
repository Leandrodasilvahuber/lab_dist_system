import * as database from '../../../../common/database.mjs';
import { DomainError, ResetLimitError } from '../../../../common/errors.mjs';
import { QUOTA_ID_PREFIX, isQuotaItem, limitFromEnv, quotaDay, quotaExpiresAt } from '../../../../common/daily-quota.mjs';
import { SEED_PRODUCTS } from '../../../../common/seed-products.mjs';

// Vezes por dia que qualquer visitante pode zerar a base (DailyResetLimit no
// template.yaml); o dia vira às 12:00 de Brasília. 0 = sem limite
export const DEFAULT_DAILY_RESET_LIMIT = 10;

// Contador na tabela de sagas com o prefixo comum (daily-quota.mjs), que a
// limpeza mantém: apagar os contadores liberaria de novo o limite diário de
// compras (e o de resets e o de caos) a cada reset
const RESET_COUNTER_PREFIX = `${QUOTA_ID_PREFIX}reset_`;
// Chamadas que continuam um mesmo reset sem gastar outra vez. Passou disso, o
// próximo POST conta como reset novo: continuar de graça não pode ser ilimitado
export const MAX_RESET_CONTINUATIONS = 20;

// Ordem da limpeza: primeiro o que sobrou fora do seed no catálogo (o seed já
// foi regravado), depois o histórico de compras
const TABLES = ['products', 'inventory', 'sagas', 'orders', 'payments', 'stockreservations'];
// Itens por página do scan; cada página vira até 10 BatchWriteItem de 25
const SCAN_PAGE_SIZE = 250;
// Tempo para começar uma página nova. A Gateway tem 15s (Globals do
// template.yaml); a última página (scan de até 5s + exclusões) cabe na folga
export const DEFAULT_RESET_BUDGET_MS = 8000;

const SEED_IDS = new Set(SEED_PRODUCTS.map(product => product.id));

/**
 * Zera a base (POST /reset): grava de novo os produtos do seed (todos,
 * inclusive o Server) e apaga o resto: produtos e estoque fora do seed,
 * sagas, pedidos, pagamentos e reservas, como uma stack nova depois do
 * npm run seed.
 *
 * Aberto a todos, como a aba Caos; o que segura o abuso é o limite diário,
 * contado antes de apagar. Desligado em prod (RESET_ENABLED=false).
 *
 * Tabela grande não cabe no timeout da Lambda: o seed vai primeiro (a loja
 * fica utilizável mesmo se parar no meio) e a limpeza para ao fim do
 * orçamento de tempo, com `complete: false`. O contador do dia fica marcado
 * `unfinished` (também quando a Lambda cai no meio) e os próximos POST
 * continuam a limpeza sem gastar outra vez, até MAX_RESET_CONTINUATIONS.
 *
 * Sagas em andamento continuam no Step Functions e podem gravar nas tabelas
 * já zeradas: zere com a loja parada.
 */
export class ResetClient {
  constructor({ env = process.env, db = database, now = Date.now, budgetMs = DEFAULT_RESET_BUDGET_MS } = {}) {
    this.enabled = env.RESET_ENABLED === 'true';
    this.limit = limitFromEnv(env.RESET_DAILY_LIMIT, DEFAULT_DAILY_RESET_LIMIT);
    this.db = db;
    this.now = now;
    this.budgetMs = budgetMs;
  }

  // Dia de cota atual: id do contador e quando ele zera
  window() {
    const { day, resetsAtMs } = quotaDay(this.now());
    return { id: `${RESET_COUNTER_PREFIX}${day}`, resetsAtMs };
  }

  summary(counter) {
    const used = counter?.resets || 0;
    const unfinished = Boolean(counter?.unfinished) && (counter.continuations || 0) < MAX_RESET_CONTINUATIONS;
    const { resetsAtMs } = this.window();
    return {
      enabled: this.enabled,
      limit: this.limit,
      used,
      remaining: this.limit ? Math.max(0, this.limit - used) : null,
      unfinished,
      resetsAt: new Date(resetsAtMs).toISOString()
    };
  }

  async status() {
    if (!this.enabled) return { enabled: false };
    return this.summary(await this.counter());
  }

  counter() {
    return this.db.getItem('sagas', { id: this.window().id }, { consistentRead: true });
  }

  async reset() {
    if (!this.enabled) throw new DomainError('Database reset is disabled in this environment', 'ResetDisabled', 409);
    // `deleted`: quanto esta chamada já apagou, em todas as tabelas
    const call = { deadline: this.now() + this.budgetMs, deleted: 0 };
    const used = (await this.continue()) ?? await this.count();
    const products = await this.seed();
    const deleted = {};
    let complete = true;
    for (const table of TABLES) {
      const result = await this.wipe(table, call);
      deleted[table] = result.deleted;
      if (!result.complete) {
        complete = false;
        break;
      }
    }
    if (complete) await this.finish();
    return { ...this.summary({ resets: used, unfinished: !complete }), complete, deleted, products };
  }

  // Continua o reset que parou no meio, sem gastar outra vez: soma 1 nas
  // continuações, só se o contador ainda está `unfinished` e abaixo do teto.
  // Devolve os resets do dia, ou null (nada a continuar: é um reset novo)
  async continue() {
    try {
      const attributes = await this.db.updateItem('sagas', { id: this.window().id }, 'ADD continuations :one',
        { ':one': 1, ':true': true, ':max': MAX_RESET_CONTINUATIONS },
        {
          retry: false,
          returnValues: 'ALL_NEW',
          expressionAttributeNames: { '#unfinished': 'unfinished' },
          conditionExpression: '#unfinished = :true AND (attribute_not_exists(continuations) OR continuations < :max)'
        });
      return attributes.resets;
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      return null;
    }
  }

  // Soma 1 no contador do dia, só se ainda não chegou ao limite, e marca a
  // limpeza como não terminada (continuações zeradas). Conta antes de apagar:
  // um reset que falha no meio também gasta a vez (o próximo POST continua sem
  // gastar outra)
  async count() {
    const { id, resetsAtMs } = this.window();
    try {
      const attributes = await this.db.updateItem('sagas', { id },
        'ADD resets :one SET expiresAt = :expiresAt, #unfinished = :true, continuations = :zero',
        { ':one': 1, ':zero': 0, ':true': true, ':expiresAt': quotaExpiresAt(resetsAtMs), ...(this.limit && { ':limit': this.limit }) },
        {
          retry: false,
          expressionAttributeNames: { '#unfinished': 'unfinished' },
          ...(this.limit && { conditionExpression: 'attribute_not_exists(resets) OR resets < :limit' })
        });
      return attributes.resets;
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      throw new ResetLimitError(this.limit, {
        resetsAt: new Date(resetsAtMs).toISOString(),
        retryAfterSeconds: Math.ceil((resetsAtMs - this.now()) / 1000)
      });
    }
  }

  finish() {
    return this.db.updateItem('sagas', { id: this.window().id }, 'REMOVE #unfinished, continuations', undefined,
      { expressionAttributeNames: { '#unfinished': 'unfinished' } });
  }

  // Apaga página por página até acabar a tabela ou o orçamento de tempo.
  // Mantém os contadores de cota e, no catálogo, os produtos do seed. O prazo
  // só vale depois de a chamada apagar algo: sem isso, uma continuação podia
  // gastar o tempo todo relendo tabelas já limpas e nunca avançar
  async wipe(table, call) {
    const keep = table === 'products' || table === 'inventory'
      ? item => SEED_IDS.has(item.id) || isQuotaItem(item)
      : isQuotaItem;
    let deleted = 0;
    let startKey;
    do {
      if (call.deleted && this.now() >= call.deadline) return { deleted, complete: false };
      const page = await this.db.scanPage(table, { limit: SCAN_PAGE_SIZE, startKey });
      const keys = page.items.filter(item => !keep(item)).map(item => ({ id: item.id }));
      await this.db.batchDelete(table, keys);
      deleted += keys.length;
      call.deleted += keys.length;
      startKey = page.lastKey;
    } while (startKey);
    return { deleted, complete: true };
  }

  async seed() {
    const now = new Date(this.now()).toISOString();
    await Promise.all(SEED_PRODUCTS.map(async ({ stock, devOnly: _devOnly, ...product }) => {
      await this.db.putItem('products', { ...product, createdAt: now, updatedAt: now });
      await this.db.putItem('inventory', { id: product.id, name: product.name, stock, createdAt: now, updatedAt: now });
    }));
    return SEED_PRODUCTS.length;
  }
}
