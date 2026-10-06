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
