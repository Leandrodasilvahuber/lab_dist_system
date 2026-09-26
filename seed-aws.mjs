import { execSync } from 'child_process';

console.log('🌟 SEED AWS - Criando produtos de fruta\n');

const fruits = [
  { id: 'apple', name: 'Apple', price: 5.99, stock: 10 },
  { id: 'banana', name: 'Banana', price: 3.49, stock: 15 },
  { id: 'orange', name: 'Orange', price: 4.99, stock: 20 },
  { id: 'grape', name: 'Grape', price: 8.99, stock: 30 }
];

console.log('📦 Produtos de fruta:');
console.log(fruits.map(f => `  ${f.id}: ${f.name} (${f.stock} unidades)`).join('\n'));

try {
  // 1. Verificar se tabela Products existe
  console.log('\n1️⃣  Verificando tabela Products...');

  try {
    execSync('aws dynamodb describe-table --table-name Products', { stdio: 'inherit' });
    console.log('\n✅ Tabela Products já existe!');
  } catch (error) {
    console.log('\n🆕 Criando tabela Products...');
    console.log('   Comando: aws dynamodb create-table --table-name Products ...');

    execSync('aws dynamodb create-table --table-name Products --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST', { stdio: 'inherit' });
    console.log('\n✅ Tabela Products criada com sucesso!');
  }

  // 2. Inserir/atualizar produtos
  console.log('\n2️⃣  Inserindo/atualizando produtos...');

  for (const fruit of fruits) {
    const item = JSON.stringify({
      id: fruit.id,
      name: fruit.name,
      price: fruit.price,
      stock: fruit.stock,
      ordersInProgress: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    console.log(`   Inserindo/Atualizando ${fruit.name}...`);
    execSync(`aws dynamodb put-item --table-name Products --item '${item}'`, { stdio: 'inherit' });
  }

  console.log('\n✅ Todos os produtos inseridos!');

  // 3. Verificar produtos
  console.log('\n3️⃣  Verificando produtos...');
  console.log('   Comando: aws dynamodb scan --table-name Products');

  execSync('aws dynamodb scan --table-name Products --output table', { stdio: 'inherit' });

  // 4. Mostrar resumo
  console.log('\n4️⃣  Resumo final:');
  console.log('   📦 Produtos criados/atualizados: 4');
  console.log('   🍎 Apple: 10 unidades');
  console.log('   🍌 Banana: 15 unidades');
  console.log('   🍊 Orange: 20 unidades');
  console.log('   🍇 Grape: 30 unidades');

  console.log('\n✅ Seed concluído com sucesso!');

} catch (error) {
  if (error.message.includes('ResourceInUseException')) {
    console.log('\n⚠️  Tabela Products já existe, pulando criação...');
  } else {
    console.error('\n❌ Erro no seed:', error.message);
    process.exit(1);
  }
}

console.log('\n🎉 Pronto! Produtos de fruta criados com sucesso!');