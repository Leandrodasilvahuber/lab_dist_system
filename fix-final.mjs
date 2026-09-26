import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Lista de testes que precisam ser corrigidos manualmente
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

  // Step 2: Add database functions import (only once)
  if (!content.includes('import { getItem') && content.includes('import { handler')) {
    const handlerMatch = content.match(/import\s+\{\s*handler\s+as\s+\w+\}\s+from\s+['"].*\.mjs['"];?/);
    if (handlerMatch) {
      const handlerLine = handlerMatch[0];
      content = content.replace(
        handlerLine,
        handlerLine + '\nimport { getItem, updateItem, queryItems } from \'../../../src/shared/database.mjs\';'
      );
    }
  }

  // Step 3: Fix mock.method calls - replace all mock.method(global, ...) with mock.fn()
  content = content.replace(/mock\.method\(global,\s*'(\w+)'\)/g, 'mock.fn()');

  // Step 4: Replace all mock.fn() with proper function definition
  content = content.replace(/(\w+)\s*=\s*mock\.fn\(\)/g, '$1 = mock.fn()');

  // Step 5: Fix all mockResolvedValueOnce calls
  content = content.replace(/(\w+)\.mockResolvedValueOnce\(([^;]+)\);/g, '$1.mockImplementationOnce(async () => $2);');

  // Step 6: Fix all mockResolvedValue calls
  content = content.replace(/(\w+)\.mockResolvedValue\(([^;]+)\);/g, '$1.mockImplementation(async () => $2);');

  // Step 7: Replace all variable declarations to use proper mock.fn()
  content = content.replace(
    /(let\s+\w+,\s*)(\w+)([,;])/g,
    '$1$2 = mock.fn()$3'
  );

  // Step 8: Fix calls to check how many times mock was called
  content = content.replace(/(\w+)\.callCount/g, '$1.mock.callCount');
  content = content.replace(/(\w+)\.calls\[0\]/g, '$1.mock.calls[0]');

  writeFileSync(filePath, content, 'utf-8');
  console.log(`✅ Fixed: ${file}`);
});

console.log('\nAll tests have been fixed!');
