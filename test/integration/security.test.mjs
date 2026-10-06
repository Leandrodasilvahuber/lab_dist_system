/**
 * Testes de segurança da API (DAST caseiro): sobem o local-server de verdade
 * e atacam pela rede, como um cliente de fora faria.
 *   npm run test:integration   (ou npm run dast:api)
 * Auth de admin, CORS, Host (DNS rebinding) e path traversal não dependem do
 * LocalStack; com ele no ar, a validação de payload também é testada.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ADMIN_KEY = 'chave-admin-do-teste-de-seguranca';
const STACK_TRACE = /\bat .+:\d+:\d+|node:internal|\/src\/|\.mjs/;

const freePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    }).on('error', reject);
});

async function startServer(env) {
    const port = await freePort();
    const child = spawn(process.execPath, ['local-server.mjs'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'silent', ADMIN_API_KEY: '', ADMIN_API_KEY_HASH: '', CORS_ALLOW_ORIGIN: '', ...env },
        stdio: 'ignore'
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(`local-server saiu com código ${child.exitCode}`);
        const up = await fetch(`${base}/`).then(() => true, () => false);
        if (up) return { base, port, stop: () => child.kill() };
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    child.kill();
    throw new Error('local-server não respondeu em 20 s');
}

// fetch normaliza ../ do caminho; http.request manda o caminho cru, como um atacante
function rawGet(port, rawPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
            const lines = Object.entries({ Host: 'localhost', ...headers, Connection: 'close' }).map(([k, v]) => `${k}: ${v}\r\n`).join('');
            socket.write(`GET ${rawPath} HTTP/1.1\r\n${lines}\r\n`);
        });
        let data = '';
        socket.on('data', chunk => { data += chunk; });
        socket.on('end', () => resolve({ status: Number(data.split(' ')[1]), text: data }));
        socket.on('error', reject);
    });
}

const localstackUp = await fetch('http://localhost:4566/_localstack/health').then(r => r.ok, () => false);

describe('segurança da API local (com chave de admin)', () => {
    let server;
    before(async () => { server = await startServer({ ADMIN_API_KEY: ADMIN_KEY }); });
    after(() => server?.stop());

    const ADMIN_REQUESTS = [
        ['GET', '/logs'],
        ['GET', '/trace/abc'],
        ['GET', '/metrics/cost'],
        ['POST', '/metrics/cost/refresh'],
        ['POST', '/products'],
        ['DELETE', '/products/apple'],
        ['POST', '/stock/apple/adjust'],
        ['POST', '/dlq/abc/discard']
    ];

    for (const [method, path] of ADMIN_REQUESTS) {
        it(`${method} ${path} sem chave, com chave errada ou com prefixo da certa: 401`, async () => {
            for (const key of [undefined, 'errada', ADMIN_KEY.slice(0, -1), `${ADMIN_KEY}x`, ADMIN_KEY.toUpperCase()]) {
                const headers = key === undefined ? {} : { 'X-Api-Key': key };
                const response = await fetch(`${server.base}${path}`, { method, headers });
                assert.strictEqual(response.status, 401, `${method} ${path} com chave ${key}`);
            }
        });
    }

    it('chave certa passa pela autenticação', async () => {
        const response = await fetch(`${server.base}/logs`, { headers: { 'X-Api-Key': ADMIN_KEY } });
        assert.strictEqual(response.status, 200);
    });

    it('não reflete Origin de outro site (sem CORS_ALLOW_ORIGIN)', async () => {
        for (const method of ['GET', 'OPTIONS']) {
            const response = await fetch(`${server.base}/products`, { method, headers: { Origin: 'https://evil.example' } });
            assert.strictEqual(response.headers.get('access-control-allow-origin'), null, method);
        }
    });

    it('path traversal no dashboard não lê arquivos de fora', async () => {
        const attempts = [
            '/dashboard/../.env',
            '/dashboard/../../.env',
            '/dashboard/%2e%2e/.env',
            '/dashboard/%2e%2e%2f.env.test',
            '/dashboard/..%2fpackage.json',
            '/dashboard/%2e%2e/local-server.mjs',
            '/dashboard/....//.env',
            '/dashboard/%252e%252e/.env'
        ];
        for (const attempt of attempts) {
            const { status, text } = await rawGet(server.port, attempt);
            assert.notStrictEqual(status, 200, attempt);
            assert.doesNotMatch(text, /AWS_SECRET_ACCESS_KEY|"devDependencies"|createServer/, attempt);
        }
    });

    it('arquivo do dashboard com extensão não servida: 404', async () => {
        const { status } = await rawGet(server.port, '/dashboard/js/../../package.json');
        assert.notStrictEqual(status, 200);
    });

    it('body acima do limite: 413 sem stack trace', async () => {
        const response = await fetch(`${server.base}/products`, {
            method: 'POST',
            headers: { 'X-Api-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
            body: 'x'.repeat(2 * 1024 * 1024)
        });
        assert.strictEqual(response.status, 413);
        assert.doesNotMatch(await response.text(), STACK_TRACE);
    });

    it('correlationId malformado no /trace: 400', async () => {
        const response = await fetch(`${server.base}/trace/${encodeURIComponent('<script>')}`, { headers: { 'X-Api-Key': ADMIN_KEY } });
        assert.strictEqual(response.status, 400);
        assert.doesNotMatch(await response.text(), /<script>/);
    });

    describe('payloads malformados', { skip: !localstackUp && 'LocalStack indisponível em localhost:4566' }, () => {
        const BAD_PRODUCTS = [
            ['JSON inválido', '{"name": "x", '],
            ['array no lugar de objeto', '[]'],
            ['tipos errados', JSON.stringify({ name: 123, price: 'dez' })],
            ['preço negativo', JSON.stringify({ name: 'Teste de segurança', price: -1 })],
            ['nome gigante', JSON.stringify({ name: 'x'.repeat(100_000), price: 1 })],
            ['prototype pollution', '{"__proto__": {"admin": true}, "constructor": {"prototype": {"admin": true}}}']
        ];

        for (const [label, body] of BAD_PRODUCTS) {
            it(`POST /products com ${label}: 400 sem stack trace`, async () => {
                const response = await fetch(`${server.base}/products`, {
                    method: 'POST',
                    headers: { 'X-Api-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
                    body
                });
                const text = await response.text();
                assert.strictEqual(response.status, 400, `${label}: ${text}`);
                assert.doesNotMatch(text, STACK_TRACE);
            });
        }

        it('ids estranhos na URL não derrubam o serviço (404 ou 400, nunca 500)', async () => {
            for (const id of ['..%2f..%2fetc%2fpasswd', 'x'.repeat(5000), '%00', "'%20OR%201=1--", '%7B%22%24ne%22%3A1%7D']) {
                const response = await fetch(`${server.base}/products/${id}`);
                assert.ok([400, 404].includes(response.status), `/products/${id.slice(0, 40)} -> ${response.status}`);
                assert.doesNotMatch(await response.text(), STACK_TRACE);
            }
        });
    });
});

describe('segurança da API local (sem chave de admin)', () => {
    let server;
    before(async () => { server = await startServer({}); });
    after(() => server?.stop());

    it('Host de fora é recusado (DNS rebinding)', async () => {
        for (const host of ['evil.example', 'evil.example:3001', '127.0.0.1.nip.io']) {
            const { status } = await rawGet(server.port, '/logs', { Host: host });
            assert.strictEqual(status, 403, host);
        }
    });

    it('Host de loopback continua aceito', async () => {
        const response = await fetch(`${server.base}/logs`);
        assert.strictEqual(response.status, 200);
    });
});
