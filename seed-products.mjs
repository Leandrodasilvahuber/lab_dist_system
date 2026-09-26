import { putItem, scanItems } from './src/shared/database.mjs';

console.log('🌟 SEED - Criando produtos de fruta\n');

// Produtos de fruta para o seed
const fruits = [
  {
    id: 'apple',
    name: 'Apple',
    price: 5.99,
    stock: 10
  },
  {
    id: 'banana',
    name: 'Banana',
    price: 3.49,
    stock: 15
  },
  {
    id: 'orange',
    name: 'Orange',
    price: 4.99,
    stock: 20
  },
  {
    id: 'grape',
    name: 'Grape',
    price: 8.99,
    stock: 30
  }
];

console.log('Produtos a serem criados:');
fruits.forEach(fruit => {
  console.log(`- ${fruit.name}: R$${fruit.price} (${fruit.stock} unidades)`);
});

console.log('\n📦 Inserindo produtos...\n');

// Verificar quais produtos já existem
const existingProducts = await scanItems('Products');
const existingIds = new Set(existingProducts.map(p => p.id));

let createdCount = 0;
let updatedCount = 0;

for (const fruit of fruits) {
  if (existingIds.has(fruit.id)) {
    console.log(`⚠️  ${fruit.name} já existe (ID: ${fruit.id})`);
    updatedCount++;
  } else {
    const product = {
      ...fruit,
      ordersInProgress: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await putItem('Products', product);
    console.log(`✅ ${fruit.name} criado com sucesso (ID: ${fruit.id})`);
    createdCount++;
  }
}

console.log('\n📊 Resultado do seed:');
console.log(`Produtos criados: ${createdCount}`);
console.log(`Produtos já existentes: ${updatedCount}`);
console.log(`Total de produtos de fruta: ${createdCount + updatedCount}`);

// Mostrar todos os produtos de fruta
console.log('\n🍎 Lista de produtos de fruta:');
const allFruits = await scanItems('Products');
const fruitProducts = allFruits.filter(p => ['apple', 'banana', 'orange', 'grape'].includes(p.id));

fruitProducts.forEach(product => {
  console.log(`- ${product.name}: R$${product.price} | Estoque: ${product.stock} (${product.reserved || 0} reservados)`);
});

console.log('\n✅ Seed concluído!');