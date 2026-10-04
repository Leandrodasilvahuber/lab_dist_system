import { createHash } from 'node:crypto';

/**
 * Índice das sagas por dia de criação (SagasByDayIndex, template.yaml), usado
 * pela aba SLOs para ler só a janela pedida em vez de varrer a tabela.
 *
 * A chave é `YYYY-MM-DD#k` (dia em UTC, k de 0 a SAGA_DAY_SHARDS - 1): sem o
 * shard, todas as sagas do dia cairiam na mesma partição do índice. Cada saga é
 * atualizada a cada passo pelo Step Functions e o índice recebe cada
 * atualização, então uma partição só limitaria a vazão de compras (e o
 * throttling do índice atrasa as escritas da tabela). Quem lê consulta os N
 * shards de cada dia.
 */
export const SAGAS_BY_DAY_INDEX = 'SagasByDayIndex';
export const SAGA_DAY_SHARDS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

// Hash estável do id: a mesma saga sempre cai no mesmo shard
function shardOf(id) {
  return createHash('sha256').update(String(id)).digest().readUInt32BE(0) % SAGA_DAY_SHARDS;
}

export function sagaDayShard(id, createdAtIso) {
  return `${utcDay(Date.parse(createdAtIso))}#${shardOf(id)}`;
}

/** Chaves de todos os shards dos dias (UTC) entre `sinceMs` e `nowMs`, inclusive */
export function dayShardsInWindow(sinceMs, nowMs) {
  const keys = [];
  const lastDay = utcDay(nowMs);
  for (let ms = Date.parse(utcDay(sinceMs)); utcDay(ms) <= lastDay; ms += DAY_MS) {
    const day = utcDay(ms);
    for (let shard = 0; shard < SAGA_DAY_SHARDS; shard++) keys.push(`${day}#${shard}`);
  }
  return keys;
}
