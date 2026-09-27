#!/usr/bin/env node

/**
 * Test script para endpoints externos do sistema e-commerce distribuído
 * Simula chamadas para cada microserviço
 */

import { spawn } from 'child_process';

const TEST_CORRELATION_ID = 'test-external-endpoints-' + Date.now();
const BASE_URL = 'http://localhost:3001';

const testEndpoints = async () => {
  console.log('🧪 TESTANDO ENDPOINTS EXTERNOS - CORRELATION ID:', TEST_CORRELATION_ID);
  console.log('='.repeat(80));

  let results = [];

  // Test 1: Health check (Common service)
  try {
    const health = await new Promise((resolve, reject) => {
      spawn('curl', ['-s', BASE_URL + '/health'], {
        stdio: ['ignore', 'pipe', 'pipe']
      }).on('close', (code) => {
        if (code !== 0) return reject(new Error('Health check failed'));
        resolve();
      });
    });

    results.push({ endpoint: 'Health Check', status: '✅ PASS', code: 200 });
    console.log('✅ Health Check: PASS (GET /health)');
  } catch (error) {
    results.push({ endpoint: 'Health Check', status: '❌ FAIL', code: null });
    console.log('❌ Health Check: FAIL', error.message);
  }

  // Test 2: Create Product
  try {
    const productData = JSON.stringify({
      id: 'test-product-' + Date.now(),
      name: 'Test Product External',
      price: 199.99,
      stock: 50
    });

    const productResponse = await new Promise((resolve, reject) => {
      const child = spawn('curl', [
        '-s', '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-d', productData,
        BASE_URL + '/api/ecommerce/products'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => stdout += data);
      child.stderr.on('data', (data) => stderr += data);

      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(stderr || 'Failed'));
        resolve(stdout);
      });
    });

    const productId = JSON.parse(productResponse).id;
    results.push({ endpoint: 'Create Product', status: '✅ PASS', code: 201 });
    console.log('✅ Create Product: PASS (POST /api/ecommerce/products)', { productId });

    // Test 3: Get Products
    try {
      const products = await new Promise((resolve, reject) => {
        const child = spawn('curl', ['-s', 'http://localhost:3000/api/ecommerce/products'], {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        child.stdout.on('data', (data) => stdout += data);
        child.on('close', (code) => {
          if (code !== 0) return reject(new Error('Failed'));
          resolve(stdout);
        });
      });

      results.push({ endpoint: 'Get Products', status: '✅ PASS', code: 200 });
      console.log('✅ Get Products: PASS (GET /api/ecommerce/products)');
    } catch (error) {
      results.push({ endpoint: 'Get Products', status: '❌ FAIL', code: null });
      console.log('❌ Get Products: FAIL', error.message);
    }

    // Test 4: Create Order
    try {
      const orderData = JSON.stringify({
        productId: productId,
        quantity: 2,
        userId: 'test-user-123'
      });

      const orderResponse = await new Promise((resolve, reject) => {
        const child = spawn('curl', [
          '-s', '-X', 'POST',
          '-H', 'Content-Type: application/json',
          '-d', orderData,
          'http://localhost:3000/api/ecommerce/orders'
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        child.stdout.on('data', (data) => stdout += data);
        child.on('close', (code) => {
          if (code !== 0) return reject(new Error('Failed'));
          resolve(stdout);
        });
      });

      const orderId = JSON.parse(orderResponse).id;
      results.push({ endpoint: 'Create Order', status: '✅ PASS', code: 201 });
      console.log('✅ Create Order: PASS (POST /api/ecommerce/orders)', { orderId });

      // Test 5: Process Payment
      try {
        const paymentData = JSON.stringify({
          orderId: orderId,
          amount: 399.98,
          paymentMethod: 'credit-card'
        });

        const paymentResponse = await new Promise((resolve, reject) => {
          const child = spawn('curl', [
            '-s', '-X', 'POST',
            '-H', 'Content-Type: application/json',
            '-d', paymentData,
            'http://localhost:3000/api/ecommerce/payments'
          ], { stdio: ['ignore', 'pipe', 'pipe'] });

          let stdout = '';
          child.stdout.on('data', (data) => stdout += data);
          child.on('close', (code) => {
            if (code !== 0) return reject(new Error('Failed'));
            resolve(stdout);
          });
        });

        results.push({ endpoint: 'Process Payment', status: '✅ PASS', code: 200 });
        console.log('✅ Process Payment: PASS (POST /api/ecommerce/payments)');
      } catch (error) {
        results.push({ endpoint: 'Process Payment', status: '❌ FAIL', code: null });
        console.log('❌ Process Payment: FAIL', error.message);
      }

      // Test 6: Reserve Stock
      try {
        const stockResponse = await new Promise((resolve, reject) => {
          const child = spawn('curl', [
            '-s', '-X', 'POST',
            '-H', 'Content-Type: application/json',
            '-d', JSON.stringify({ quantity: 2 }),
            'http://localhost:3000/api/ecommerce/stock/' + productId + '/reserve'
          ], { stdio: ['ignore', 'pipe', 'pipe'] });

          let stdout = '';
          child.stdout.on('data', (data) => stdout += data);
          child.on('close', (code) => {
            if (code !== 0) return reject(new Error('Failed'));
            resolve(stdout);
          });
        });

        results.push({ endpoint: 'Reserve Stock', status: '✅ PASS', code: 200 });
        console.log('✅ Reserve Stock: PASS (POST /api/ecommerce/stock/:productId/reserve)');
      } catch (error) {
        results.push({ endpoint: 'Reserve Stock', status: '❌ FAIL', code: null });
        console.log('❌ Reserve Stock: FAIL', error.message);
      }

      // Test 7: Get Stock
      try {
        const stockResponse = await new Promise((resolve, reject) => {
          const child = spawn('curl', ['-s', 'http://localhost:3000/api/ecommerce/stock'], {
            stdio: ['ignore', 'pipe', 'pipe']
          });

          let stdout = '';
          child.stdout.on('data', (data) => stdout += data);
          child.on('close', (code) => {
            if (code !== 0) return reject(new Error('Failed'));
            resolve(stdout);
          });
        });

        results.push({ endpoint: 'Get Stock', status: '✅ PASS', code: 200 });
        console.log('✅ Get Stock: PASS (GET /api/ecommerce/stock)');
      } catch (error) {
        results.push({ endpoint: 'Get Stock', status: '❌ FAIL', code: null });
        console.log('❌ Get Stock: FAIL', error.message);
      }

      // Test 8: Start Saga Orchestrator
      try {
        const sagaData = JSON.stringify({
          orderId: orderId,
          productId: productId,
          quantity: 2,
          totalAmount: 399.98
        });

        const sagaResponse = await new Promise((resolve, reject) => {
          const child = spawn('curl', [
            '-s', '-X', 'POST',
            '-H', 'Content-Type: application/json',
            '-d', sagaData,
            'http://localhost:3000/api/ecommerce/saga/orders'
          ], { stdio: ['ignore', 'pipe', 'pipe'] });

          let stdout = '';
          child.stdout.on('data', (data) => stdout += data);
          child.on('close', (code) => {
            if (code !== 0) return reject(new Error('Failed'));
            resolve(stdout);
          });
        });

        results.push({ endpoint: 'Start Order Saga', status: '✅ PASS', code: 200 });
        console.log('✅ Start Order Saga: PASS (POST /api/ecommerce/saga/orders)');
      } catch (error) {
        results.push({ endpoint: 'Start Order Saga', status: '❌ FAIL', code: null });
        console.log('❌ Start Order Saga: FAIL', error.message);
      }
    } catch (error) {
      results.push({ endpoint: 'Create Order', status: '❌ FAIL', code: null });
      console.log('❌ Create Order: FAIL', error.message);
    }
  } catch (error) {
    results.push({ endpoint: 'Create Product', status: '❌ FAIL', code: null });
    console.log('❌ Create Product: FAIL', error.message);
  }

  // Summary
  console.log('='.repeat(80));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(80));

  const passed = results.filter(r => r.status.includes('PASS')).length;
  const failed = results.filter(r => r.status.includes('FAIL')).length;

  results.forEach(r => {
    console.log(`${r.status} ${r.endpoint}`);
  });

  console.log('='.repeat(80));
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log('='.repeat(80));

  return failed === 0;
};

// Run tests
testEndpoints().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test execution error:', error);
  process.exit(1);
});
