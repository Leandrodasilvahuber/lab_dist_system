import { API_BASE } from './config.js';

// Login de admin na AWS: o dashboard fala direto com o Cognito (sem SDK) e a
// API só recebe o access token, que vale 1 h. A senha nunca passa pela API.
// No local-server (sem Cognito) o login continua pela chave X-Api-Key

// Região no formato da AWS (us-east-1, ap-southeast-2...): o host do login é
// sempre cognito-idp.<região>.amazonaws.com, nunca um endereço vindo da API
// eslint-disable-next-line security/detect-unsafe-regex -- grupos curtos e sem sobreposição
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

let configPromise;

/** `{ mode: 'cognito', region, clientId }` ou `{ mode: 'key' }` (GET /auth/config). */
export function loadAuthConfig(fetchFn = fetch) {
    configPromise ??= fetchFn(`${API_BASE}/auth/config`)
        .then(response => {
            if (response.ok) return response.json();
            // API sem a rota (versão antiga): chave, e fica guardado
            if (response.status === 404) return {};
            throw new Error(`HTTP ${response.status}`);
        })
        .then(parseAuthConfig)
        // Fora do ar, 429, 5xx: chave por ora, sem guardar (a próxima chamada
        // pergunta de novo, em vez de prender a página no modo chave até recarregar)
        .catch(() => {
            configPromise = undefined;
            return { mode: 'key' };
        });
    return configPromise;
}

export function parseAuthConfig(body = {}) {
    if (body.mode === 'cognito' && REGION.test(body.region ?? '') && typeof body.clientId === 'string' && body.clientId) {
        return { mode: 'cognito', region: body.region, clientId: body.clientId };
    }
    return { mode: 'key' };
}

const MESSAGES = {
    NotAuthorizedException: 'usuário ou senha incorretos',
    UserNotFoundException: 'usuário ou senha incorretos',
    PasswordResetRequiredException: 'a senha precisa ser redefinida (scripts/deploy.sh com ADMIN_PASSWORD)',
    TooManyRequestsException: 'muitas tentativas, tente de novo em instantes'
};

async function call({ region }, target, payload, fetchFn) {
    const response = await fetchFn(`https://cognito-idp.${region}.amazonaws.com/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-amz-json-1.1',
            'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`
        },
        body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const code = String(body.__type ?? '').split('#').pop();
        const error = new Error(MESSAGES[code] ?? body.message ?? `Cognito HTTP ${response.status}`);
        error.code = code;
        throw error;
    }
    return body;
}

function tokens(body, now) {
    const result = body.AuthenticationResult;
    // NEW_PASSWORD_REQUIRED e afins: o deploy.sh grava a senha como permanente
    if (!result) throw new Error(`o Cognito pediu ${body.ChallengeName ?? 'um passo extra'}, que o dashboard não suporta`);
    return { accessToken: result.AccessToken, refreshToken: result.RefreshToken, expiresAt: now() + result.ExpiresIn * 1000 };
}

export async function login(config, username, password, { fetchFn = fetch, now = Date.now } = {}) {
    const body = await call(config, 'InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: config.clientId,
        AuthParameters: { USERNAME: username, PASSWORD: password }
    }, fetchFn);
    return tokens(body, now);
}

/** Novo access token; a resposta do Cognito não traz outro refresh token. */
export async function refresh(config, refreshToken, { fetchFn = fetch, now = Date.now } = {}) {
    const body = await call(config, 'InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: config.clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken }
    }, fetchFn);
    return { ...tokens(body, now), refreshToken };
}

/**
 * Invalida o refresh token (sair). O access token já emitido continua aceito
 * pelo HttpApi até expirar (no máximo 1 h): o authorizer não consulta o Cognito.
 */
export function revoke(config, refreshToken, { fetchFn = fetch } = {}) {
    return call(config, 'RevokeToken', { Token: refreshToken, ClientId: config.clientId }, fetchFn);
}
