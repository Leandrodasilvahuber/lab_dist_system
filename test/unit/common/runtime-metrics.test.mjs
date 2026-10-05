import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { withRuntimeMetrics, runtimeFunctionName } from '../../../src/common/runtime-metrics.mjs';
import { extractEmfMetrics } from '../../../src/common/emf.mjs';

describe('withRuntimeMetrics', () => {
  const original = { level: process.env.LOG_LEVEL, name: process.env.AWS_LAMBDA_FUNCTION_NAME };
  afterEach(() => {
    process.env.LOG_LEVEL = original.level;
    if (original.name === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = original.name;
    mock.restoreAll();
  });

  function capture() {
    process.env.LOG_LEVEL = 'info';
    const out = mock.method(console, 'log', () => {});
    return () => out.mock.calls.map(c => JSON.parse(c.arguments[0]));
  }

  it('grava MemoryUsedMB por FunctionName e devolve o resultado do handler', async () => {
    const lines = capture();
    const handler = withRuntimeMetrics(async event => ({ echo: event }), { functionName: () => 'fn', local: false });

    assert.deepStrictEqual(await handler(1), { echo: 1 });
    const [line] = lines();
    const data = extractEmfMetrics(line);
    assert.deepStrictEqual(data.map(d => [d.MetricName, d.Unit, d.Dimensions]), [['MemoryUsedMB', 'Megabytes', [{ Name: 'FunctionName', Value: 'fn' }]]]);
    assert.ok(data[0].Value > 0);
  });

  it('no perfil local também grava InvocationDurationMs (base da estimativa de custo)', async () => {
    const lines = capture();
    await withRuntimeMetrics(async () => 'ok', { functionName: () => 'fn', local: true })();
    assert.deepStrictEqual(extractEmfMetrics(lines()[0]).map(d => d.MetricName).sort(), ['InvocationDurationMs', 'MemoryUsedMB']);
  });

  it('grava mesmo quando o handler lança, sem engolir o erro', async () => {
    const lines = capture();
    const handler = withRuntimeMetrics(async () => { throw new Error('boom'); }, { functionName: () => 'fn', local: false });
    await assert.rejects(handler(), /boom/);
    assert.strictEqual(lines()[0].event, 'RUNTIME_METRICS');
  });

  it('nome da série: a Lambda ou, fora dela, o local-server', () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    assert.strictEqual(runtimeFunctionName(), 'local-server');
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'dev-OrderFunction';
    assert.strictEqual(runtimeFunctionName(), 'dev-OrderFunction');
  });
});
