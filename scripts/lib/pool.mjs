/**
 * Roda `fn` para cada item com no máximo `limit` ao mesmo tempo, mantendo a
 * ordem dos resultados. Os testes locais usam LOCAL_MAX_CONCURRENCY
 * (scripts/lib/localstack.mjs): mais que isso sobrecarrega o LocalStack.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
