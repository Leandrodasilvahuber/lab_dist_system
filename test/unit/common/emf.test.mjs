import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { emfFields, extractEmfMetrics, metricNamespace } from '../../../src/common/emf.mjs';

describe('emf', () => {
  const original = process.env.ENVIRONMENT;
  afterEach(() => { process.env.ENVIRONMENT = original; });

  it('namespace segue o ENVIRONMENT (local sem ele)', () => {
    delete process.env.ENVIRONMENT;
    assert.strictEqual(metricNamespace(), 'Ecommerce/local');
    process.env.ENVIRONMENT = 'dev';
    assert.strictEqual(metricNamespace(), 'Ecommerce/dev');
  });

  it('emfFields monta uma diretiva por grupo e põe valores e dimensões na raiz', () => {
    process.env.ENVIRONMENT = 'dev';
    const fields = emfFields([
      { metrics: { BusinessErrors: { value: 1 } }, dimensions: { ErrorType: 'PaymentDeclined' }, dimensionSets: [[], ['ErrorType']] },
      { metrics: { ActionDuration: { value: 42, unit: 'Milliseconds' } }, dimensions: { Action: 'processPayment' }, dimensionSets: [['Action']] }
    ], 1000);

    assert.deepStrictEqual(fields._aws, {
      Timestamp: 1000,
      CloudWatchMetrics: [
        { Namespace: 'Ecommerce/dev', Dimensions: [[], ['ErrorType']], Metrics: [{ Name: 'BusinessErrors', Unit: 'Count' }] },
        { Namespace: 'Ecommerce/dev', Dimensions: [['Action']], Metrics: [{ Name: 'ActionDuration', Unit: 'Milliseconds' }] }
      ]
    });
    assert.strictEqual(fields.ErrorType, 'PaymentDeclined');
    assert.strictEqual(fields.BusinessErrors, 1);
    assert.strictEqual(fields.ActionDuration, 42);
  });

  it('sem métricas não acrescenta nada', () => {
    assert.deepStrictEqual(emfFields([]), {});
    assert.deepStrictEqual(emfFields([{ metrics: {} }]), {});
  });

  it('extractEmfMetrics faz o inverso: uma entrada por métrica × conjunto de dimensões', () => {
    process.env.ENVIRONMENT = 'local';
    const entry = { event: 'X', ...emfFields([{ metrics: { BusinessErrors: { value: 1 } }, dimensions: { ErrorType: 'NotFound' }, dimensionSets: [[], ['ErrorType']] }], 5000) };
    assert.deepStrictEqual(extractEmfMetrics(entry), [
      { Namespace: 'Ecommerce/local', MetricName: 'BusinessErrors', Value: 1, Unit: 'Count', Timestamp: new Date(5000), Dimensions: [] },
      { Namespace: 'Ecommerce/local', MetricName: 'BusinessErrors', Value: 1, Unit: 'Count', Timestamp: new Date(5000), Dimensions: [{ Name: 'ErrorType', Value: 'NotFound' }] }
    ]);
  });

  it('extractEmfMetrics ignora linha sem _aws, valor não numérico e dimensão ausente', () => {
    assert.deepStrictEqual(extractEmfMetrics({ event: 'X' }), []);
    const entry = {
      _aws: { Timestamp: 1, CloudWatchMetrics: [{ Namespace: 'N', Dimensions: [['Falta']], Metrics: [{ Name: 'A' }, { Name: 'B' }] }] },
      A: 'x', B: 2
    };
    assert.deepStrictEqual(extractEmfMetrics(entry), []);
  });
});
