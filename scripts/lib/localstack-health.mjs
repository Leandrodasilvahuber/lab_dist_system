/**
 * Detecta um defeito do LocalStack (4.14) sob carga: o cache de esquemas das
 * tabelas do DynamoDB (um TTLCache sem lock) se corrompe e, a partir daí, toda
 * Query com IndexName, em qualquer tabela, responde 500 com
 * "exception while calling dynamodb.Query: 'arn:...:table/<nome>'". As
 * reservas de estoque, os SLOs e as compras novas passam a falhar, e recriar a
 * tabela não resolve: só reiniciar o LocalStack limpa o cache.
 *
 * Sem este aviso, o sintoma é só uma sequência de 503 e sagas que não terminam.
 */
export function isCorruptedSchemaCache(error) {
  const message = String(error?.message || '');
  return /exception while calling dynamodb\.\w+/.test(message) && message.includes(':table/');
}

export const RESET_HINT = [
  '⚠️  LocalStack com o cache de tabelas do DynamoDB corrompido: toda consulta por índice falha.',
  '   Reinicie (apaga os dados, PERSISTENCE=0):',
  '   npm run localstack:stop && npm run localstack:start && npm run seed:local && npm run localstack:deploy',
  '   e depois reinicie o local-server.'
].join('\n');

/**
 * `probe`: uma consulta por índice barata. Avisa uma vez quando o defeito
 * aparece e de novo só depois de voltar ao normal. Outras falhas (LocalStack
 * fora do ar, timeout) não são este defeito e ficam com quem já as reporta.
 */
export function createLocalstackHealth({ probe, warn = console.warn, info = console.log }) {
  let corrupted = false;

  async function check() {
    try {
      await probe();
      if (corrupted) info('✅ LocalStack: consultas por índice voltaram a responder.');
      corrupted = false;
    } catch (error) {
      if (!isCorruptedSchemaCache(error)) return corrupted;
      if (!corrupted) warn(RESET_HINT);
      corrupted = true;
    }
    return corrupted;
  }

  function start(intervalMs = 60 * 1000) {
    check();
    const timer = setInterval(check, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { check, start, isCorrupted: () => corrupted };
}
