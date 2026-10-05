import { describe, it } from 'node:test';
import assert from 'node:assert';

// Importação dinâmica para evitar problemas de dependências complexas
async function loadPaymentSDK() {
  const { default: PaymentSDK } = await import('../../../src/common/sdks/PaymentSDK.js');
  return PaymentSDK;
}

describe('PaymentSDK', () => {
  it('should export PaymentSDK class', async () => {
    const PaymentSDK = await loadPaymentSDK();
    assert.ok(PaymentSDK);
    assert.strictEqual(typeof PaymentSDK, 'function');
  });

  it('should create PaymentSDK instance', async () => {
    const PaymentSDK = await loadPaymentSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new PaymentSDK(dbClient, eventBridgeClient);
    assert.ok(sdk);
    assert.strictEqual(sdk.constructor, PaymentSDK);
  });

  it('should have processPayment method on instance', async () => {
    const PaymentSDK = await loadPaymentSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new PaymentSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.processPayment, 'function');
  });

  it('should have getPayment method on instance', async () => {
    const PaymentSDK = await loadPaymentSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new PaymentSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.getPayment, 'function');
  });

  it('should have refundPaymentById method on instance', async () => {
    const PaymentSDK = await loadPaymentSDK();
    const dbClient = {};
    const eventBridgeClient = {};
    const sdk = new PaymentSDK(dbClient, eventBridgeClient);
    assert.strictEqual(typeof sdk.refundPaymentById, 'function');
  });
});
describe('PaymentSDK: limite do gateway simulado', () => {
  it('PAYMENT_MAX_AMOUNT ausente usa o padrão; inválido falha em vez de recusar tudo', async () => {
    const { maxApprovedAmount } = await import('../../../src/common/sdks/PaymentSDK.js');
    assert.strictEqual(maxApprovedAmount(undefined), 10000);
    assert.strictEqual(maxApprovedAmount(''), 10000);
    assert.strictEqual(maxApprovedAmount('250.5'), 250.5);
    for (const raw of ['abc', '0', '-1']) {
      assert.throws(() => maxApprovedAmount(raw), /PAYMENT_MAX_AMOUNT/, raw);
    }
  });
});
