import { API_BASE } from './core/config.js';
import { $ } from './core/dom.js';
import { on } from './core/events.js';
import { escapeHtml } from './core/format.js';
import { navigate } from './core/nav.js';
import { currentView, initRouter, refreshCurrent, show, syncAdminViews } from './core/router.js';
import { getAdminKey, setAdminKey } from './core/session.js';
import { storage } from './core/storage.js';
import { icon } from './components/icons.js';
import { showToast } from './components/toast.js';
import { runMonitors } from './views/monitoring.js';
import { openTrace } from './views/trace.js';

// ---------- Casca: ícones fixos e endpoint ----------
$('brandMark').innerHTML = icon('bag', { size: 19 });
$('menuBtn').innerHTML = icon('menu', { size: 20 });
$('sidebarEndpoint').innerHTML = `<strong>API</strong>${escapeHtml(API_BASE.replace(/^https?:\/\//, ''))}`;

// ---------- Barra lateral em telas estreitas (gaveta) ----------
const app = $('app');

function toggleSidebar(open = !app.classList.contains('nav-open')) {
    app.classList.toggle('nav-open', open);
    $('menuBtn').setAttribute('aria-expanded', String(open));
}

$('menuBtn').addEventListener('click', () => toggleSidebar());
$('scrim').addEventListener('click', () => toggleSidebar(false));

// ---------- Navegação: links do menu, atalhos e lupas em qualquer tela ----------
document.addEventListener('click', event => {
    const trace = event.target.closest('[data-trace]');
    if (trace) {
        openTrace(trace.dataset.trace);
        return;
    }
    const link = event.target.closest('[data-nav]');
    if (link) {
        event.preventDefault();
        navigate(link.dataset.nav);
        toggleSidebar(false);
    }
});

// ---------- Indicador de conexão (alimentado pelo Monitoramento) ----------
on('health', ({ healthy }) => {
    $('connectionDot').className = `connection-dot ${healthy ? 'connected' : 'disconnected'}`;
    $('connectionStatus').textContent = healthy ? 'Conectado' : 'Desconectado';
    $('statusLink').title = `${healthy ? 'Sistema saudável' : 'API indisponível'} · ver monitoramento`;
});

// ---------- Tema claro/escuro (sem escolha, segue o sistema) ----------
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (document.documentElement.dataset.theme || (prefersDark.matches ? 'dark' : 'light')) === 'dark';

function renderThemeButton() {
    const dark = isDark();
    $('themeBtn').innerHTML = icon(dark ? 'sun' : 'moon', { size: 18 });
    $('themeBtn').title = dark ? 'Usar tema claro' : 'Usar tema escuro';
    $('themeBtn').setAttribute('aria-label', $('themeBtn').title);
}

$('themeBtn').addEventListener('click', () => {
    const theme = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    storage.set('theme', theme);
    renderThemeButton();
});
prefersDark.addEventListener('change', renderThemeButton);

// ---------- Login de admin: popover no canto superior direito ----------
const adminBtn = $('adminBtn');
const adminPopover = $('adminPopover');
const adminKeyInput = $('adminKey');

function renderAdminButton() {
    const active = Boolean(getAdminKey());
    adminBtn.innerHTML = `${icon(active ? 'unlock' : 'lock', { size: 15 })}<span>${active ? 'Admin ativo' : 'Admin'}</span>`;
    adminBtn.classList.toggle('is-admin', active);
    adminBtn.title = active ? 'Chave de admin ativa' : 'Entrar como admin';
}

function toggleAdminPopover(open = adminPopover.hidden) {
    adminPopover.hidden = !open;
    adminBtn.setAttribute('aria-expanded', String(open));
    if (open) {
        adminKeyInput.value = getAdminKey();
        adminKeyInput.focus();
    }
}

on('admin', () => {
    renderAdminButton();
    syncAdminViews();
    toggleAdminPopover(false);
    // Saiu do admin estando numa tela de admin: show() volta para a inicial
    if (!getAdminKey()) show(currentView(), { notify: false });
    else refreshCurrent();
});

adminBtn.addEventListener('click', event => {
    event.stopPropagation();
    toggleAdminPopover();
});
$('adminForm').addEventListener('submit', event => {
    event.preventDefault();
    const value = adminKeyInput.value.trim();
    setAdminKey(value);
    showToast(value ? 'Chave de admin ativa.' : 'Chave de admin removida.', 'info');
});
$('adminLogout').addEventListener('click', () => {
    setAdminKey('');
    showToast('Saiu do modo admin.', 'info');
});
document.addEventListener('click', event => {
    if (!adminPopover.hidden && !adminPopover.contains(event.target)) toggleAdminPopover(false);
});
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!adminPopover.hidden) toggleAdminPopover(false);
    toggleSidebar(false);
});

// ---------- Inicialização ----------
renderThemeButton();
renderAdminButton();
initRouter();
// O indicador do topo vale em qualquer tela; no Monitoramento o refresh já roda
if (currentView() !== 'monitoring') runMonitors();
// Aba oculta pula a rodada: várias abas esquecidas não somam consultas
setInterval(() => { if (!document.hidden) runMonitors(); }, 30000);
