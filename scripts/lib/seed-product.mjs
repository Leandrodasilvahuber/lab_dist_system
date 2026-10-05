/**
 * Gravação de um produto do seed sem recriar produto excluído. Usado por
 * scripts/seed.mjs; recebe as funções de src/common/database.mjs (`db`).
 *
 * Produto excluído deixa o inventário marcado `deleted` (StockSDK.removeInventory):
 * recriar só o produto o devolveria ao catálogo sem estoque e impossível de
 * comprar. A checagem do inventário e a gravação do produto vão na mesma
 * transação, sem janela entre ler e gravar.
 *
 * Retorna 'written' | 'exists' | 'deleted'
 */
export async function writeProductUnlessDeleted(db, product) {
  try {
    await db.transactWrite([
      { ConditionCheck: { table: 'inventory', Key: { id: product.id }, ConditionExpression: 'attribute_not_exists(deleted)' } },
      { Put: { table: 'products', Item: product, ConditionExpression: 'attribute_not_exists(id)' } }
    ]);
    return 'written';
  } catch (error) {
    if (error.name !== 'TransactionCanceledException') throw error;
    const reasons = (error.CancellationReasons || []).map(r => r?.Code);
    // Cancelada por outro motivo (ex.: conflito com outra transação): não dá para concluir nada
    if (reasons.some(code => code && code !== 'None' && code !== 'ConditionalCheckFailed')) throw error;
    if (reasons.length) return reasons[0] === 'ConditionalCheckFailed' ? 'deleted' : 'exists';
    // Sem os motivos (emulador que não os devolve): o inventário diz qual condição falhou
    const inventory = await db.getItem('inventory', { id: product.id }, { consistentRead: true });
    return inventory?.deleted ? 'deleted' : 'exists';
  }
}
