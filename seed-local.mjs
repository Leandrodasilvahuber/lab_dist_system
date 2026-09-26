// Versão local do seed para demonstração
console.log('🌟 SEED LOCAL - Criando produtos de fruta (simulação)\n');

// Produtos de fruta para o seed
const fruits = [
  {
    id: 'apple',
    name: 'Apple',
    price: 5.99,
    stock: 10,
    ordersInProgress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'banana',
    name: 'Banana',
    price: 3.49,
    stock: 15,
    ordersInProgress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'orange',
    name: 'Orange',
    price: 4.99,
    stock: 20,
    ordersInProgress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'grape',
    name: 'Grape',
    price: 8.99,
    stock: 30,
    ordersInProgress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

console.log('📦 Produtos a serem criados:');
fruits.forEach(fruit => {
  console.log(`  ${fruit.id}: ${fruit.name} - R$${fruit.price} (${fruit.stock} unidades)`);
});

console.log('\n🔧 Para criar o seed na AWS DynamoDB:');
console.log('\n1. Criar tabela no DynamoDB:');
console.log('   aws dynamodb create-table \\');
console.log('     --table-name Products \\');
console.log('     --attribute-definitions AttributeName=id,AttributeType=S \\');
console.log('     --key-schema AttributeName=id,KeyType=HASH \\');
console.log('     --billing-mode PAY_PER_REQUEST');

console.log('\n2. Inserir produtos:');
fruits.forEach((fruit, index) => {
  console.log(`\naws dynamodb put-item \\`);
  console.log('  --table-name Products \\');
  console.log(`  --item \'${JSON.stringify(fruit).replace(/"/g, '"')}\'`);
});

console.log('\n3. Para verificar:');
console.log('   aws dynamodb scan --table-name Products');

console.log('\n📊 Dados dos produtos:');
console.log(fruits.map(f =>
  `${f.id}: ${f.name} - R$${f.price} - Estoque: ${f.stock}`
).join('\n'));

console.log('\n✅ Seed pronto para deploy!');