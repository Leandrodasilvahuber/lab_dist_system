import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Lista de testes que precisam ser corrigidos
const testFiles = [
  'test/unit/ecommerce/cancel-order.test.mjs',
  'test/unit/ecommerce/confirm-order.test.mjs',
  'test/unit/ecommerce/get-order.test.mjs',
  'test/unit/ecommerce/get-products.test.mjs',
  'test/unit/ecommerce/refund-payment.test.mjs',
  'test/unit/ecommerce/release-stock.test.mjs',
  'test/unit/ecommerce/reserve-stock.test.mjs',
];

testFiles.forEach(file => {
  const filePath = join(__dirname, file);
  let content = readFileSync(filePath, 'utf-8');

  // Step 1: Remove imports of Database class
  content = content.replace(
    /import\s+\{\s*Database\s*\}\s+from\s+['"].*database\.mjs['"];?\n?/g,
    ''
  );

  // Step 2: Add database functions import
  if (content.includes('import { handler') && !content.includes('import { getItem')) {
    content = content.replace(
      /(import\s+\{\s*handler[^}]+\}\s+from\s+['"].*\.mjs['"];?\n)/,
      (match) => {
        const handlerMatch = match.match(/handler as (\w+)/);
        const handlerName = handlerMatch ? handlerMatch[1] : 'handler';
        return `import { ${handlerName} as handler } from '../../../src/functions/ecommerce/${handlerName.toLowerCase()}.mjs';\nimport { getItem, updateItem, queryItems } from '../../../src/shared/database.mjs';\n${match}`;
      }
    );
  }

  // Step 3: Replace all mock.method(Database, ...) calls with mock.method(global, ...)
  content = content.replace(/mock\.method\(Database,\s*'(\w+)'\)/g, 'mock.method(global, \'$1\')');

  // Step 4: Replace all mock.method(global, 'getItem') with mock.method() - the first argument is the function to mock
  content = content.replace(/mock\.method\(global,\s*'getItem'\)/g, 'getItemSpy');

  // Step 5: Replace all mock.method(global, 'updateItem') with mock.method()
  content = content.replace(/mock\.method\(global,\s*'updateItem'\)/g, 'updateItemSpy');

  // Step 6: Replace all mock.method(global, 'queryItems') with mock.method()
  content = content.replace(/mock\.method\(global,\s*'queryItems'\)/g, 'queryItemsSpy');

  // Step 7: Fix variable declarations - replace "let mockEvent, getItemSpy" with proper structure
  content = content.replace(
    /(let\s+\w+,\s*)(getItemSpy|updateItemSpy|queryItemsSpy)([,;])$/,
    '$1$2 = mock.method(global, \'getItem\')$3'
  );

  writeFileSync(filePath, content, 'utf-8');
  console.log(`✅ Fixed: ${file}`);
});

console.log('\nAll tests have been fixed!');
