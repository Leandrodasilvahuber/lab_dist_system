// localStorage pode faltar (aba privada, bloqueio): sem ele, vale só nesta sessão
export const storage = {
    get(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sem storage: só nesta sessão */ }
    }
};
