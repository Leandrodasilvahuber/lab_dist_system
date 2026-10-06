import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// config.js lê a API de location ao carregar; sessionStorage em memória
globalThis.location = { search: '', protocol: 'http:', origin: 'http://localhost:3001' };
const memory = new Map();
globalThis.sessionStorage = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: key => memory.delete(key)
};
globalThis.localStorage = { removeItem: () => {} };

const { login, refresh, revoke, parseAuthConfig, loadAuthConfig } = await import('../../../dashboard/js/core/cognito.js');
const { authHeaders, getCredential, isAdmin, setCredential } = await import('../../../dashboard/js/core/session.js');

const CONFIG = { mode: 'cognito', region: 'us-east-1', clientId: 'client123' };
const NOW = 1_000_000;

// fetch falso: guarda as chamadas e responde na ordem
function fakeFetch(...responses) {
    const calls = [];
    const fn = async (url, options) => {
        calls.push({ url, target: options?.headers?.['X-Amz-Target'], body: options?.body && JSON.parse(options.body) });
        const { status = 200, body } = responses.shift();
        return { ok: status < 400, status, json: async () => body };
    };
    fn.calls = calls;
    return fn;
}

const authResult = (token, extra = {}) => ({ AuthenticationResult: { AccessToken: token, ExpiresIn: 3600, ...extra } });

describe('dashboard: config do login', () => {
    // Primeiro teste do arquivo: a config fica guardada no módulo depois do sucesso
    it('falha ao ler a config não fica guardada; a resposta certa fica', async () => {
        assert.deepStrictEqual(await loadAuthConfig(async () => { throw new Error('offline'); }), { mode: 'key' });
        assert.deepStrictEqual(await loadAuthConfig(fakeFetch({ status: 503, body: {} })), { mode: 'key' });
        assert.deepStrictEqual(await loadAuthConfig(fakeFetch({ body: CONFIG })), CONFIG);
        // Guardada: este fetch nem é chamado
        assert.deepStrictEqual(await loadAuthConfig(() => assert.fail('não deveria pedir de novo')), CONFIG);
    });

    it('aceita só região no formato da AWS e client definido', () => {
        assert.deepStrictEqual(parseAuthConfig(CONFIG), CONFIG);
        assert.deepStrictEqual(parseAuthConfig({ mode: 'key' }), { mode: 'key' });
        assert.deepStrictEqual(parseAuthConfig({}), { mode: 'key' });
        // Região que mudaria o host do login (a senha iria para outro lugar)
        for (const region of ['evil.com/', 'us-east-1.evil.com#', 'US-EAST-1', '']) {
            assert.deepStrictEqual(parseAuthConfig({ ...CONFIG, region }), { mode: 'key' }, region);
        }
        assert.deepStrictEqual(parseAuthConfig({ ...CONFIG, clientId: '' }), { mode: 'key' });
    });
});

describe('dashboard: Cognito', () => {
    it('login manda usuário e senha só ao Cognito da região e devolve os tokens', async () => {
        const fetchFn = fakeFetch({ body: authResult('access1', { RefreshToken: 'refresh1' }) });
        const tokens = await login(CONFIG, 'admin', 'S3nha!', { fetchFn, now: () => NOW });
        assert.deepStrictEqual(tokens, { accessToken: 'access1', refreshToken: 'refresh1', expiresAt: NOW + 3600 * 1000 });
        const [call] = fetchFn.calls;
        assert.strictEqual(call.url, 'https://cognito-idp.us-east-1.amazonaws.com/');
        assert.strictEqual(call.target, 'AWSCognitoIdentityProviderService.InitiateAuth');
        assert.deepStrictEqual(call.body, {
            AuthFlow: 'USER_PASSWORD_AUTH', ClientId: 'client123', AuthParameters: { USERNAME: 'admin', PASSWORD: 'S3nha!' }
        });
    });

    it('senha errada vira mensagem legível com o código do Cognito', async () => {
        const fetchFn = fakeFetch({ status: 400, body: { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' } });
        await assert.rejects(login(CONFIG, 'admin', 'x', { fetchFn }),
            error => error.code === 'NotAuthorizedException' && /usuário ou senha incorretos/.test(error.message));
    });

    it('desafio (ex.: trocar a senha) não vira login pela metade', async () => {
        const fetchFn = fakeFetch({ body: { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's' } });
        await assert.rejects(login(CONFIG, 'admin', 'x', { fetchFn }), /NEW_PASSWORD_REQUIRED/);
    });

    it('refresh mantém o refresh token (o Cognito não manda outro)', async () => {
        const fetchFn = fakeFetch({ body: authResult('access2') });
        const tokens = await refresh(CONFIG, 'refresh1', { fetchFn, now: () => NOW });
        assert.deepStrictEqual(tokens, { accessToken: 'access2', refreshToken: 'refresh1', expiresAt: NOW + 3600 * 1000 });
        assert.deepStrictEqual(fetchFn.calls[0].body.AuthParameters, { REFRESH_TOKEN: 'refresh1' });
    });

    it('sair revoga o refresh token', async () => {
        const fetchFn = fakeFetch({ body: {} });
        await revoke(CONFIG, 'refresh1', { fetchFn });
        assert.strictEqual(fetchFn.calls[0].target, 'AWSCognitoIdentityProviderService.RevokeToken');
        assert.deepStrictEqual(fetchFn.calls[0].body, { Token: 'refresh1', ClientId: 'client123' });
    });
});

describe('dashboard: sessão de admin', () => {
    beforeEach(() => setCredential(null));

    it('sem login não manda credencial', async () => {
        assert.ok(!isAdmin());
        assert.deepStrictEqual(await authHeaders(), {});
    });

    it('local: chave vai no X-Api-Key', async () => {
        setCredential({ type: 'key', value: 'chave' });
        assert.deepStrictEqual(await authHeaders(), { 'X-Api-Key': 'chave' });
    });

    it('chave guardada por versões antigas (texto) continua valendo', () => {
        setCredential('chave-antiga');
        assert.deepStrictEqual(getCredential(), { type: 'key', value: 'chave-antiga' });
    });

    it('Cognito: access token válido vai como Bearer, sem refresh', async () => {
        setCredential({ type: 'cognito', username: 'admin', accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 30 * 60 * 1000 });
        assert.deepStrictEqual(await authHeaders(), { Authorization: 'Bearer tok' });
    });

    // fetch global (usado pelo refresh de session.js): só o Cognito, na ordem
    function cognitoFetch(...responses) {
        const fn = fakeFetch(...responses);
        globalThis.fetch = fn;
        return fn;
    }
    const expired = () => ({ type: 'cognito', username: 'admin', accessToken: 'velho', refreshToken: 'r', expiresAt: Date.now() - 1000 });

    it('Cognito: token vencido é renovado uma vez para requisições em paralelo', async () => {
        const fetchFn = cognitoFetch({ body: authResult('novo') });
        setCredential(expired());
        const headers = await Promise.all([authHeaders(), authHeaders(), authHeaders()]);
        assert.deepStrictEqual(headers, Array(3).fill({ Authorization: 'Bearer novo' }));
        assert.strictEqual(fetchFn.calls.length, 1);
        assert.strictEqual(getCredential().refreshToken, 'r');
    });

    it('Cognito: force renova mesmo com o token ainda válido (depois de um 401)', async () => {
        cognitoFetch({ body: authResult('novo') });
        setCredential({ ...expired(), expiresAt: Date.now() + 30 * 60 * 1000 });
        assert.deepStrictEqual(await authHeaders({ force: true }), { Authorization: 'Bearer novo' });
    });

    it('Cognito: refresh token revogado ou vencido sai do modo admin', async () => {
        cognitoFetch({ status: 400, body: { __type: 'NotAuthorizedException', message: 'Refresh Token has expired' } });
        setCredential(expired());
        assert.deepStrictEqual(await authHeaders(), {});
        assert.ok(!isAdmin());
    });

    it('Cognito: falha de rede no refresh mantém a sessão', async () => {
        globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
        setCredential(expired());
        assert.deepStrictEqual(await authHeaders(), { Authorization: 'Bearer velho' });
        assert.ok(isAdmin());
    });

    it('Cognito: sair durante o refresh descarta os tokens novos', async () => {
        let release;
        globalThis.fetch = () => new Promise(resolve => { release = resolve; });
        setCredential(expired());
        const pending = authHeaders();
        await new Promise(resolve => setImmediate(resolve));
        setCredential(null);
        release({ ok: true, status: 200, json: async () => authResult('novo') });
        assert.deepStrictEqual(await pending, {});
        assert.strictEqual(getCredential(), null);
    });
});
