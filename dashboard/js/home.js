// Tema e idioma da página inicial. O tema em si (padrão claro) é aplicado antes do
// primeiro paint por js/theme-init.js; a escolha usa a mesma chave 'theme' do
// dashboard, então vale para as duas páginas. O idioma vem de js/i18n.js, com as
// traduções em js/home-i18n.js; o botão de CV (data-href-pt/en/es) aponta para o
// PDF do idioma escolhido.
import { createI18n } from './i18n.js';
import { DICT } from './home-i18n.js';

const root = document.documentElement;
const btn = document.getElementById('themeBtn');

function renderTheme() {
    const dark = root.dataset.theme === 'dark';
    btn.textContent = dark ? '☀️' : '🌙';
    btn.title = i18n.t(dark ? 'theme.light' : 'theme.dark');
    btn.setAttribute('aria-label', btn.title);
}

btn.addEventListener('click', () => {
    const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = theme;
    try { localStorage.setItem('theme', JSON.stringify(theme)); } catch { /* sem storage: vale só nesta visita */ }
    renderTheme();
});

const i18n = createI18n({ dict: DICT, onChange: renderTheme });
