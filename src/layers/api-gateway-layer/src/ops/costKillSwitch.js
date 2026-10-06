import { ApiGatewayV2Client, GetStageCommand, UpdateStageCommand } from '@aws-sdk/client-apigatewayv2';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { log } from '../../../../common/logger.mjs';

const BLOCKED = { ThrottlingBurstLimit: 0, ThrottlingRateLimit: 0 };

// Assunto do alerta do AWS Budgets ("AWS Budgets: <nome> has exceeded your
// alert threshold"). Qualquer outra mensagem no tópico (teste, publicação por
// engano) é ignorada: bloquear a API por uma mensagem errada derruba a loja
export const BUDGET_EXCEEDED = /has exceeded your alert threshold/i;

const isBlocked = settings => settings?.ThrottlingRateLimit === 0 && settings?.ThrottlingBurstLimit === 0;

// Só os limites: o UpdateStage recusa campos de leitura vindos do GetStage
const limitsOf = settings => settings && {
  ThrottlingBurstLimit: settings.ThrottlingBurstLimit,
  ThrottlingRateLimit: settings.ThrottlingRateLimit
};

/**
 * Interruptor de custo: o CostKillSwitchBudget (template.yaml) publica no
 * CostKillSwitchTopic quando o gasto real passa do teto, e esta Lambda zera o
 * throttling do stage do HttpApi (padrão e todas as rotas com limite próprio).
 * A partir daí toda requisição recebe 429 do API Gateway, sem chegar às Lambdas.
 *
 * Bloqueio manual (teste): invoque com {"action":"trip"}.
 * Os limites anteriores ficam num parâmetro do SSM. Para religar:
 *   aws lambda invoke --function-name <CostKillSwitchFunction> \
 *     --cli-binary-format raw-in-base64-out --payload '{"action":"restore"}' /dev/stdout
 * Um novo deploy só reaplica os limites se o template mudar (o CloudFormation
 * não corrige a alteração feita fora dele). Se mudar, a API volta a responder
 * mesmo bloqueada, e o backup fica com os limites antigos: depois desse
 * deploy, não use o restore (os limites já são os do template).
 * O Budget avisa uma vez por mês: depois de um restore, novo gasto acima do
 * teto no mesmo mês não bloqueia de novo.
 */
export function createHandler({
  apiId = process.env.API_ID,
  stageName = process.env.STAGE_NAME,
  backupParam = process.env.THROTTLE_BACKUP_PARAM,
  apigw = new ApiGatewayV2Client({}),
  ssm = new SSMClient({})
} = {}) {
  async function trip(reason) {
    const stage = await apigw.send(new GetStageCommand({ ApiId: apiId, StageName: stageName }));
    if (isBlocked(stage.DefaultRouteSettings)) {
      log({ event: 'COST_KILL_SWITCH_ALREADY_ON', status: 'info', message: `Stage ${stageName} already blocked` });
      return { blocked: true, changed: false };
    }
    const routeSettings = stage.RouteSettings || {};
    const backup = {
      DefaultRouteSettings: limitsOf(stage.DefaultRouteSettings),
      RouteSettings: Object.fromEntries(Object.entries(routeSettings).map(([route, s]) => [route, limitsOf(s)]))
    };
    // Backup antes de bloquear: sem ele não haveria como religar
    await ssm.send(new PutParameterCommand({ Name: backupParam, Type: 'String', Overwrite: true, Value: JSON.stringify(backup) }));
    await apigw.send(new UpdateStageCommand({
      ApiId: apiId,
      StageName: stageName,
      DefaultRouteSettings: BLOCKED,
      RouteSettings: Object.fromEntries(Object.keys(routeSettings).map(route => [route, BLOCKED]))
    }));
    log({
      event: 'COST_KILL_SWITCH_ON',
      status: 'error',
      message: `Monthly budget exceeded: stage ${stageName} blocked (all routes respond 429)`,
      data: { reason, routes: Object.keys(routeSettings).length }
    });
    return { blocked: true, changed: true };
  }

  async function restore() {
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: backupParam }));
    const backup = JSON.parse(Parameter.Value);
    await apigw.send(new UpdateStageCommand({ ApiId: apiId, StageName: stageName, ...backup }));
    log({ event: 'COST_KILL_SWITCH_OFF', status: 'info', message: `Stage ${stageName} throttling restored` });
    return { blocked: false };
  }

  return async function handler(event) {
    if (!apiId || !stageName || !backupParam) throw new Error('API_ID, STAGE_NAME and THROTTLE_BACKUP_PARAM must be configured');
    if (event?.action === 'restore') return restore();
    if (event?.action === 'trip') return trip('manual');
    const subject = event?.Records?.[0]?.Sns?.Subject || '';
    if (BUDGET_EXCEEDED.test(subject)) return trip(subject);
    log({ event: 'COST_KILL_SWITCH_IGNORED', status: 'warn', message: 'Message is not a budget-exceeded alert: API left untouched', data: { subject } });
    return { blocked: false, ignored: true };
  };
}

export const handler = createHandler();
