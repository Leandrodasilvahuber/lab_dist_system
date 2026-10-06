/**
 * Catálogo e estoque do seed: usado por scripts/seed.mjs e pelo POST /reset
 * (gateway), que zera a base e grava estes produtos de novo.
 *
 * `devOnly`: fica fora do perfil prod do seed (o Server testa pagamento
 * recusado). Só decide o perfil, não vai para a tabela.
 */
export const SEED_PRODUCTS = [
  { id: 'apple', name: 'Apple', price: 5.99, stock: 10 },
  { id: 'banana', name: 'Banana', price: 3.49, stock: 15 },
  { id: 'orange', name: 'Orange', price: 4.99, stock: 20 },
  { id: 'grape', name: 'Grape', price: 8.99, stock: 30 },
  { id: 'server', name: 'Server (testa pagamento recusado)', price: 25000, stock: 5, devOnly: true }
];
