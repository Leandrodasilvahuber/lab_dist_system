// Barramento mínimo entre as telas: quem carrega dados avisa, quem exibe escuta
// ('products', 'admin', 'health')
const listeners = new Map();

export function on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(fn);
}

export function emit(name, payload) {
    for (const fn of listeners.get(name) || []) fn(payload);
}
