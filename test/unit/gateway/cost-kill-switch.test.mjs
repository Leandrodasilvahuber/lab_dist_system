import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHandler } from '../../../src/layers/api-gateway-layer/src/ops/costKillSwitch.js';

process.env.LOG_LEVEL = 'silent';

// Stage em memória (GetStage/UpdateStage) e parâmetro do SSM
function fakes(stage) {
  const params = {};
  const apigw = {
    updates: [],
    async send(command) {
      if (command.constructor.name === 'GetStageCommand') return structuredClone(stage);
      const { DefaultRouteSettings, RouteSettings = {} } = command.input;
      this.updates.push(command.input);
      if (DefaultRouteSettings) stage.DefaultRouteSettings = { ...stage.DefaultRouteSettings, ...DefaultRouteSettings };
      for (const [route, settings] of Object.entries(RouteSettings)) stage.RouteSettings[route] = { ...stage.RouteSettings[route], ...settings };
      return {};
    }
  };
  const ssm = {
    async send(command) {
      if (command.constructor.name === 'PutParameterCommand') params[command.input.Name] = command.input.Value;
      else return { Parameter: { Value: params[command.input.Name] } };
      return {};
    }
  };
  return { apigw, ssm, params };
}

const snsEvent = { Records: [{ Sns: { Subject: 'AWS Budgets: dev-ecommerce-monthly has exceeded your alert threshold' } }] };

describe('CostKillSwitch', () => {
  const config = { apiId: 'api1', stageName: 'dev', backupParam: '/dev/ecommerce/throttle-backup' };
  const initialStage = () => ({
    StageName: 'dev',
    DefaultRouteSettings: { ThrottlingBurstLimit: 20, ThrottlingRateLimit: 20, DetailedMetricsEnabled: false },
    RouteSettings: { 'GET /logs': { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 2 } }
  });

  it('notificação do Budget zera o padrão e todas as rotas, guardando os limites', async () => {
    const stage = initialStage();
    const { apigw, ssm, params } = fakes(stage);
    const result = await createHandler({ ...config, apigw, ssm })(snsEvent);

    assert.deepStrictEqual(result, { blocked: true, changed: true });
    assert.deepStrictEqual(stage.DefaultRouteSettings.ThrottlingRateLimit, 0);
    assert.deepStrictEqual(stage.RouteSettings['GET /logs'], { ThrottlingBurstLimit: 0, ThrottlingRateLimit: 0 });
    // Só os limites no backup (o UpdateStage recusaria campos de leitura)
    assert.deepStrictEqual(JSON.parse(params[config.backupParam]), {
      DefaultRouteSettings: { ThrottlingBurstLimit: 20, ThrottlingRateLimit: 20 },
      RouteSettings: { 'GET /logs': { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 2 } }
    });
  });

  it('segunda notificação não sobrescreve o backup com os zeros', async () => {
    const stage = initialStage();
    const { apigw, ssm, params } = fakes(stage);
    const handler = createHandler({ ...config, apigw, ssm });
    await handler(snsEvent);
    const backup = params[config.backupParam];
    assert.deepStrictEqual(await handler(snsEvent), { blocked: true, changed: false });
    assert.strictEqual(params[config.backupParam], backup);
    assert.strictEqual(apigw.updates.length, 1);
  });

  it('restore devolve os limites anteriores', async () => {
    const stage = initialStage();
    const { apigw, ssm } = fakes(stage);
    const handler = createHandler({ ...config, apigw, ssm });
    await handler(snsEvent);
    assert.deepStrictEqual(await handler({ action: 'restore' }), { blocked: false });
    assert.strictEqual(stage.DefaultRouteSettings.ThrottlingRateLimit, 20);
    assert.deepStrictEqual(stage.RouteSettings['GET /logs'], { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 2 });
  });

  it('ignora mensagem que não é alerta de Budget estourado; {action: trip} bloqueia', async () => {
    const stage = initialStage();
    const { apigw, ssm } = fakes(stage);
    const handler = createHandler({ ...config, apigw, ssm });
    for (const event of [{}, { Records: [{ Sns: { Subject: 'teste' } }] }, { Records: [{ Sns: {} }] }]) {
      assert.deepStrictEqual(await handler(event), { blocked: false, ignored: true });
    }
    assert.strictEqual(apigw.updates.length, 0);
    assert.deepStrictEqual(await handler({ action: 'trip' }), { blocked: true, changed: true });
    assert.strictEqual(stage.DefaultRouteSettings.ThrottlingRateLimit, 0);
  });

  it('sem configuração falha em vez de bloquear às cegas', async () => {
    const { apigw, ssm } = fakes(initialStage());
    await assert.rejects(createHandler({ apigw, ssm, apiId: '', stageName: 'dev', backupParam: 'p' })(snsEvent));
  });
});
