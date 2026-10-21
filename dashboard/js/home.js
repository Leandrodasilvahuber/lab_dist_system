// Tema e idioma da página inicial. A página sempre abre no escuro (js/theme-init.js,
// antes do primeiro paint); o botão troca o tema só durante a visita. O idioma vem de js/i18n.js, com as
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
    renderTheme();
});

const i18n = createI18n({ dict: DICT, onChange: renderTheme });
