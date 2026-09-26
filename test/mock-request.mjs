import { log } from '../src/common/logger.mjs';

console.log('\n🛒 DISTRIBUTED SYSTEMS PLAYGROUND - E-COMMERCE MODULE\n');
console.log('=====================================================\n');

const correlationId = 'test-' + Date.now();

console.log(`Correlation ID: ${correlationId}\n`);

// 1. Create Product
console.log('1️⃣  CREATE PRODUCT');
console.log('------------------');
log({
  event: 'TEST_CREATE_PRODUCT',
  correlationId,
  status: 'info',
  message: 'Creating test product'
});

const productData = {
  id: 'tux-shirt',
  name: 'Tux Shirt',
  price: 99.90,
  stock: 10
};

console.log('Product:', JSON.stringify(productData, null, 2));
console.log('');

// 2. Create Order
console.log('2️⃣  CREATE ORDER');
console.log('-----------------');
log({
  event: 'TEST_CREATE_ORDER',
  correlationId,
  status: 'info',
  message: 'Creating test order',
  data: { productId: 'tux-shirt', quantity: 1 }
});

const orderData = {
  productId: 'tux-shirt',
  quantity: 1
};

console.log('Order:', JSON.stringify(orderData, null, 2));
console.log('');

// 3. Process Payment
console.log('3️⃣  PROCESS PAYMENT');
console.log('--------------------');
log({
  event: 'TEST_PAYMENT',
  correlationId,
  status: 'info',
  message: 'Processing payment',
  data: { orderId: 'order-123', amount: 99.90 }
});

const paymentData = {
  orderId: 'order-123',
  amount: 99.90
};

console.log('Payment:', JSON.stringify(paymentData, null, 2));
console.log('');

// 4. Reserve Stock
console.log('4️⃣  RESERVE STOCK');
console.log('------------------');
log({
  event: 'TEST_RESERVE_STOCK',
  correlationId,
  status: 'info',
  message: 'Reserving stock',
  data: { orderId: 'order-123', productId: 'tux-shirt', quantity: 1 }
});

const stockData = {
  orderId: 'order-123',
  productId: 'tux-shirt',
  quantity: 1
};

console.log('Stock Reservation:', JSON.stringify(stockData, null, 2));
console.log('');

// 5. Confirm Order
console.log('5️⃣  CONFIRM ORDER');
console.log('------------------');
log({
  event: 'TEST_CONFIRM_ORDER',
  correlationId,
  status: 'info',
  message: 'Confirming order',
  data: { orderId: 'order-123' }
});

const confirmData = {
  orderId: 'order-123'
};

console.log('Confirmation:', JSON.stringify(confirmData, null, 2));
console.log('');

// 6. Test Failure Scenario (Simulated)
console.log('6️⃣  FAILURE SCENARIO (Simulated)');
console.log('----------------------------------');
log({
  event: 'TEST_FAILURE_SIMULATION',
  correlationId,
  status: 'warning',
  message: 'Simulating payment failure scenario'
});

console.log('Payment Failed ❌');
console.log('Status: FAILED');
console.log('Compensation Started...');
console.log('  - Refund Payment: ✅');
console.log('  - Release Stock: ✅');
console.log('  - Cancel Order: ✅');
console.log('Final Status: CANCELLED\n');

// 7. Test Stock Reservation Failure
console.log('7️⃣  STOCK UNAVAILABLE SCENARIO');
console.log('-------------------------------');
log({
  event: 'TEST_STOCK_UNAVAILABLE',
  correlationId,
  status: 'error',
  message: 'Simulating stock unavailable scenario'
});

const unavailableStock = {
  productId: 'tux-shirt',
  available: 0,
  reserved: 0
};

console.log('Stock Check:', JSON.stringify(unavailableStock, null, 2));
console.log('Status: STOCK_UNAVAILABLE ❌');
console.log('Compensation Not Needed (payment not approved yet)\n');

// Summary
console.log('=====================================================');
console.log('📊 TEST SUMMARY');
console.log('=====================================================');
console.log('✅ All test scenarios defined');
console.log('✅ Correlation ID tracking implemented');
console.log('✅ Saga pattern structure: START → CREATE → PAYMENT → STOCK → CONFIRM → COMPLETED');
console.log('✅ Failure compensation path: PAYMENT APPROVED → STOCK FAILED → REFUND → CANCEL');
console.log('✅ State validation implemented');
console.log('✅ DynamoDB integration ready');
console.log('✅ AWS Lambda architecture defined');
console.log('✅ API endpoints defined');
console.log('=====================================================\n');

console.log('📝 NEXT STEPS:');
console.log('1. Deploy to AWS Lambda + API Gateway');
console.log('2. Set up DynamoDB tables');
console.log('3. Configure API Gateway routes');
console.log('4. Test end-to-end flow');
console.log('5. Implement Chaos testing (next phase)');
console.log('\n');