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

// DOM mínimo: cada id vira um elemento falso com os campos que a view usa
const elements = new Map();
globalThis.document = {
    getElementById: id => {
        if (!elements.has(id)) {
            const listeners = {};
            elements.set(id, {
                id,
                value: id === 'memoryHours' ? '3' : '14',
                innerHTML: '',
                textContent: '',
                listeners,
                addEventListener: (type, fn) => { listeners[type] = fn; },
                querySelector: () => null
            });
        }
        return elements.get(id);
    }
};

const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });

// fetch falso: o /health responde na hora; as leituras de métricas ficam
// pendentes até o teste soltá-las, então dá para contar quantas estão em andamento
let environment;
let healthDown = false;
let memoryBody;
let pending = [];
globalThis.fetch = async url => {
    if (url.endsWith('/health')) {
        if (healthDown) throw new TypeError('Failed to fetch');
        return json(200, { status: 'healthy', environment });
    }
    const body = url.includes('/metrics/memory') ? memoryBody : null;
    return new Promise(resolve => pending.push({ url, release: () => resolve(body ? json(200, body) : json(503, { error: 'indisponível' })) }));
};

// Esvazia as microtasks: tudo o que podia andar sem o fetch andou
const settle = () => new Promise(resolve => setImmediate(resolve));
const releaseAll = async () => {
    const batch = pending;
    pending = [];
    batch.forEach(request => request.release());
    await settle();
};

// Cada teste com o módulo novo: o ambiente fica guardado na view
let loads = 0;
const loadView = async () => (await import(`../../../dashboard/js/views/resources.js?v=${loads++}`)).default;

describe('dashboard: leitura da aba Recursos', () => {
    beforeEach(() => {
        pending = [];
        healthDown = false;
        memoryBody = undefined;
    });

    it('na AWS memória e custo vão em paralelo', async () => {
        environment = 'aws';
        const view = await loadView();
        const done = view.refresh();
        await settle();
        assert.strictEqual(pending.length, 2);
        await releaseAll();
        await done;
    });

    it('no LocalStack vão em fila, uma de cada vez', async () => {
        environment = 'localstack';
        const view = await loadView();
        const done = view.refresh();
        await settle();
        assert.deepStrictEqual(pending.map(r => new URL(r.url).pathname), ['/metrics/memory']);
        await releaseAll();
        assert.deepStrictEqual(pending.map(r => new URL(r.url).pathname), ['/metrics/cost']);
        await releaseAll();
        await done;
        assert.match(elements.get('resourcesUpdated').textContent, /^às /);
    });

    it('no LocalStack a troca de um select durante a leitura entra na mesma fila', async () => {
        environment = 'localstack';
        const view = await loadView();
        view.mount();
        const done = view.refresh();
        await settle();
        elements.get('costDays').listeners.change();
        await settle();
        assert.strictEqual(pending.length, 1);
        for (let i = 0; i < 3; i++) await releaseAll();
        assert.strictEqual(pending.length, 0);
        await done;
    });

    it('sem o /health, vai em fila (o lado seguro)', async () => {
        healthDown = true;
        const view = await loadView();
        const done = view.refresh();
        await settle();
        assert.strictEqual(pending.length, 1);
        await releaseAll();
        await releaseAll();
        await done;
    });

    it('erro inesperado na memória não impede o custo nem prende o "Carregando..."', async () => {
        environment = 'localstack';
        memoryBody = {}; // sem `functions`: a view lança TypeError
        const view = await loadView();
        // O erro continua chegando a quem chamou (o handler já fica preso aqui)
        const done = assert.rejects(view.refresh(), TypeError);
        await settle();
        await releaseAll();
        assert.deepStrictEqual(pending.map(r => new URL(r.url).pathname), ['/metrics/cost']);
        await releaseAll();
        await done;
        assert.match(elements.get('resourcesUpdated').textContent, /^às /);
        assert.match(elements.get('costEstimatedChart').innerHTML, /Não foi possível calcular o custo/);
    });
});
