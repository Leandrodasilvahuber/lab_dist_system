const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Os limites diários (compras, leitura manual do Cost Explorer) viram às
// 12:00 em Brasília (UTC-3, sem horário de verão desde 2019)
export const QUOTA_RESET_UTC_HOUR = 15;

/**
 * Dia de cota que contém `nowMs`: `day` é a data (AAAA-MM-DD) em que ele
 * começou, às 12:00 de Brasília, e `resetsAtMs` o instante em que ele zera.
 */
export function quotaDay(nowMs) {
  const day = new Date(nowMs - QUOTA_RESET_UTC_HOUR * HOUR_MS).toISOString().slice(0, 10);
  return { day, resetsAtMs: Date.parse(`${day}T00:00:00Z`) + DAY_MS + QUOTA_RESET_UTC_HOUR * HOUR_MS };
}

// Limite lido do ambiente: inteiro >= 0 (0 desliga); ausente ou inválido, o padrão
export function limitFromEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 0 ? limit : fallback;
}

// Contadores diários na tabela de sagas (compras em PurchaseQuota, resets da
// base em ResetClient, ativações de caos em ChaosClient): quota_<...>. Sem
// dayShard nem createdAt, ficam fora do SagasByDayIndex; listSagas, getSaga,
// o SLO e o reset da base os ignoram pelo prefixo, e o TTL (expiresAt) os apaga
export const QUOTA_ID_PREFIX = 'quota_';
// Folga do TTL depois que o dia zera (o DynamoDB apaga em até ~48 h)
export const QUOTA_EXPIRES_AFTER_RESET_S = 24 * 60 * 60;

export const isQuotaItem = item => String(item?.id).startsWith(QUOTA_ID_PREFIX);

// expiresAt (segundos) de um contador do dia que zera em `resetsAtMs`
export const quotaExpiresAt = resetsAtMs => Math.floor(resetsAtMs / 1000) + QUOTA_EXPIRES_AFTER_RESET_S;
