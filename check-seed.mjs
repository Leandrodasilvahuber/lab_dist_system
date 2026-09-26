import { execSync } from 'child_process';

console.log('🔍 Verificando estado dos produtos de fruta\n');

try {
  // Verificar produtos na tabela
  console.log('📦 Produtos na tabela Products:');

  const result = execSync('aws dynamodb scan --table-name Products --query "Items[*].[id, name, stock, ordersInProgress]" --output json', { encoding: 'utf8' });
  const products = JSON.parse(result);

  if (products.length === 0) {
    console.log('\n❌ Nenhum produto encontrado na tabela Products');
  } else {
    console.log('\n📊 Estado atual dos produtos:');
    console.log('');

    products.forEach(product => {
      const [id, name, stock, ordersInProgress] = product;
      console.log(`  ${id}: ${name}`);
      console.log(`    📦 Estoque: ${stock}`);
      console.log(`    🔄 Pedidos em andamento: ${ordersInProgress || 0}`);
      console.log('');
    });

    // Verificar quantidades esperadas
    console.log('✅ Quantidades esperadas:');
    console.log('  🍎 Apple: 10 unidades');
    console.log('  🍌 Banana: 15 unidades');
    console.log('  🍊 Orange: 20 unidades');
    console.log('  🍇 Grape: 30 unidades');

    // Verificar se todas as frutas existem
    const fruitIds = products.map(p => p[0]);
    const expectedFruits = ['apple', 'banana', 'orange', 'grape'];
    const missingFruits = expectedFruits.filter(fruit => !fruitIds.includes(fruit));

    if (missingFruits.length > 0) {
      console.log('\n⚠️  Frutas faltando:', missingFruits.join(', '));
    } else {
      console.log('\n✅ Todas as frutas estão presentes!');
    }
  }

} catch (error) {
  if (error.message.includes('ResourceNotFoundException')) {
    console.log('\n❌ Tabela Products não existe. Execute o seed primeiro:');
    console.log('   node seed-aws.mjs');
  } else {
    console.error('\n❌ Erro ao verificar produtos:', error.message);
  }
}