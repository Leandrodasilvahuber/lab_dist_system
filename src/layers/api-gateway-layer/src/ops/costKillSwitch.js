import { ApiGatewayV2Client, GetStageCommand, UpdateStageCommand } from '@aws-sdk/client-apigatewayv2';
import { CloudWatchClient, SetAlarmStateCommand } from '@aws-sdk/client-cloudwatch';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { log } from '../../../../common/logger.mjs';

const BLOCKED = { ThrottlingBurstLimit: 0, ThrottlingRateLimit: 0 };

// Assunto do alerta do AWS Budgets ("AWS Budgets: <nome> has exceeded your
// alert threshold"). Qualquer outra mensagem no tópico (teste, publicação por
// engano) é ignorada: bloquear a API por uma mensagem errada derruba a loja
export const BUDGET_EXCEEDED = /has exceeded your alert threshold/i;

// Alarme de volume (ApiFloodAlarm no template.yaml): a mensagem do CloudWatch
// é um JSON com AlarmName e NewStateValue. Só o alarme configurado, e só ao
// entrar em ALARM (a volta para OK não religa nada: o restore é manual)
function floodAlarmOf(message, alarmName) {
  if (!alarmName || typeof message !== 'string') return null;
  try {
    const alarm = JSON.parse(message);
    return alarm?.AlarmName === alarmName && alarm.NewStateValue === 'ALARM' ? alarm : null;
  } catch {
    return null;
  }
}

const isBlocked = settings => settings?.ThrottlingRateLimit === 0 && settings?.ThrottlingBurstLimit === 0;

// Só os limites: o UpdateStage recusa campos de leitura vindos do GetStage
const limitsOf = settings => settings && {
  ThrottlingBurstLimit: settings.ThrottlingBurstLimit,
  ThrottlingRateLimit: settings.ThrottlingRateLimit
};

/**
 * Interruptor de custo: o CostKillSwitchBudget (template.yaml) publica no
 * CostKillSwitchTopic quando o gasto real passa do teto, e o ApiFloodAlarm
 * quando o volume de requisições foge do normal (o Budget leva horas para ver
 * o gasto; o alarme vê o ataque em minutos). Esta Lambda zera o
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
 * O ApiFloodAlarm só avisa ao mudar de estado e continua em ALARM enquanto o
 * script insistir (os 429 contam): o restore o devolve para OK, e se o volume
 * seguir alto ele volta a ALARM na próxima avaliação e bloqueia de novo. Religue
 * depois de 10 min sem o ataque, ou o bloqueio volta em seguida.
 */
export function createHandler({
  apiId = process.env.API_ID,
  stageName = process.env.STAGE_NAME,
  backupParam = process.env.THROTTLE_BACKUP_PARAM,
  floodAlarmName = process.env.FLOOD_ALARM_NAME,
  apigw = new ApiGatewayV2Client({}),
  ssm = new SSMClient({}),
  cloudwatch = new CloudWatchClient({})
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
      message: `Cost kill switch tripped: stage ${stageName} blocked (all routes respond 429)`,
      data: { reason, routes: Object.keys(routeSettings).length }
    });
    return { blocked: true, changed: true };
  }

  async function restore() {
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: backupParam }));
    const backup = JSON.parse(Parameter.Value);
    await apigw.send(new UpdateStageCommand({ ApiId: apiId, StageName: stageName, ...backup }));
    log({ event: 'COST_KILL_SWITCH_OFF', status: 'info', message: `Stage ${stageName} throttling restored` });
    // Depois de religar (antes, o alarme poderia disparar com a API ainda
    // bloqueada e o trip seria ignorado). Se falhar, a API fica no ar sem a
    // proteção do alarme: o erro sobe para quem invocou o restore ver
    if (floodAlarmName) {
      await cloudwatch.send(new SetAlarmStateCommand({
        AlarmName: floodAlarmName,
        StateValue: 'OK',
        StateReason: 'API religada pelo restore do interruptor de custo: reavaliar o volume'
      }));
    }
    return { blocked: false };
  }

  return async function handler(event) {
    if (!apiId || !stageName || !backupParam) throw new Error('API_ID, STAGE_NAME and THROTTLE_BACKUP_PARAM must be configured');
    if (event?.action === 'restore') return restore();
    if (event?.action === 'trip') return trip('manual');
    const sns = event?.Records?.[0]?.Sns || {};
    const subject = sns.Subject || '';
    if (BUDGET_EXCEEDED.test(subject)) return trip(subject);
    const alarm = floodAlarmOf(sns.Message, floodAlarmName);
    if (alarm) return trip(`${alarm.AlarmName}: ${alarm.NewStateReason || 'ALARM'}`);
    log({ event: 'COST_KILL_SWITCH_IGNORED', status: 'warn', message: 'Message is not a budget-exceeded or flood alarm: API left untouched', data: { subject } });
    return { blocked: false, ignored: true };
  };
}

export const handler = createHandler();
