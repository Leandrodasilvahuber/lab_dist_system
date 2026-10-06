import { API_BASE } from './core/config.js';
import { $ } from './core/dom.js';
import { on } from './core/events.js';
import { escapeHtml, time } from './core/format.js';
import { navigate } from './core/nav.js';
import { currentView, initRouter, refreshCurrent, show, syncAdminViews } from './core/router.js';
import { loadAuthConfig, login, revoke } from './core/cognito.js';
import { getCredential, isAdmin, setCredential } from './core/session.js';
import { checkAdminKey } from './core/api.js';
import { storage } from './core/storage.js';
import { icon } from './components/icons.js';
import { showToast } from './components/toast.js';
import { navLink } from './components/layout.js';
import { loadChaos } from './services/chaos.js';
import { runMonitors } from './views/monitoring.js';
import { openTrace } from './views/trace.js';
import { openSagaFlow } from './components/saga-modal.js';

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

// ---------- Navegação: links do menu, atalhos, lupas e fluxo da saga em qualquer tela ----------
document.addEventListener('click', event => {
    const flow = event.target.closest('[data-flow]');
    if (flow) {
        openSagaFlow(flow.dataset.flow);
        return;
    }
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
// Conectado com alarme disparado fica em amarelo: a API responder não quer dizer
// que o sistema está saudável
on('health', ({ healthy, firing = 0 }) => {
    const alerting = healthy && firing > 0;
    $('connectionDot').className = `connection-dot ${!healthy ? 'disconnected' : alerting ? 'alerting' : 'connected'}`;
    $('connectionStatus').textContent = healthy ? 'Conectado' : 'Desconectado';
    $('statusLink').title = `${!healthy ? 'API indisponível' : alerting ? `${firing} alarme(s) disparado(s)` : 'API respondendo, sem alarmes'} · ver monitoramento`;
});

// ---------- Faixa de caos: falha injetada não deve parecer bug ----------
let chaosExpiry;
on('chaos', ({ active, expiresAt, faults = [] }) => {
    const banner = $('chaosBanner');
    banner.hidden = !active;
    clearTimeout(chaosExpiry);
    if (!active) return;
    // Expirou: as Lambdas já pararam de injetar; relê em vez de esperar o polling
    chaosExpiry = setTimeout(loadChaos, Math.max(0, Date.parse(expiresAt) - Date.now()) + 1000);
    const targets = faults.map(f => `${f.service}/${f.action || '*'}`).join(', ');
    banner.innerHTML = `${icon('zap', { size: 16 })}<span><strong>Caos ativo até ${escapeHtml(time(expiresAt))}</strong> · ${faults.length} falha(s) injetada(s): <span class="mono">${escapeHtml(targets)}</span></span>
        ${isAdmin() ? navLink('chaos', 'Gerenciar', 'arrowRight') : ''}`;
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
// Na AWS, usuário e senha do Cognito; no local-server, a chave X-Api-Key
// (GET /auth/config diz qual)
const adminBtn = $('adminBtn');
const adminPopover = $('adminPopover');
const adminUserInput = $('adminUser');
const adminKeyInput = $('adminKey');
let authConfig = { mode: 'key' };

function renderAdminButton() {
    const active = isAdmin();
    adminBtn.innerHTML = `${icon(active ? 'unlock' : 'lock', { size: 15 })}<span>${active ? 'Admin ativo' : 'Admin'}</span>`;
    adminBtn.classList.toggle('is-admin', active);
    adminBtn.title = active ? `Admin ativo${getCredential().username ? ` (${getCredential().username})` : ''}` : 'Entrar como admin';
}

function renderAdminForm() {
    const cognito = authConfig.mode === 'cognito';
    adminUserInput.hidden = !cognito;
    adminKeyInput.placeholder = cognito ? 'Senha' : 'Chave de admin';
    adminKeyInput.autocomplete = cognito ? 'current-password' : 'off';
    // Sem explicação: só o aviso de que a senha iria para o login de outra API
    const warning = cognito ? otherApiWarning() : '';
    $('adminHint').textContent = warning;
    $('adminHint').hidden = !warning;
}

// Com ?api=, é essa API que diz qual client do Cognito recebe a senha: um link
// com a API de outra pessoa mandaria a senha ao user pool dela (que pode ler a
// senha num trigger de migração). O aviso mostra para onde vai
function otherApiWarning() {
    if (API_BASE === location.origin) return '';
    let host = API_BASE;
    try { host = new URL(API_BASE).host; } catch { /* mostra o texto como veio */ }
    return `Atenção: a senha vai para o login indicado por ${host}. Só entre se esta for a sua API.`;
}

// Relê a config (a leitura que falhou não fica guardada) e ajusta o formulário
async function syncAuthConfig() {
    authConfig = await loadAuthConfig();
    renderAdminForm();
    return authConfig;
}

function toggleAdminPopover(open = adminPopover.hidden) {
    adminPopover.hidden = !open;
    adminBtn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    // A config pode ter falhado no carregamento da página (API fora do ar)
    if (authConfig.mode !== 'cognito') syncAuthConfig();
    const credential = getCredential();
    if (authConfig.mode === 'cognito') {
        // A senha nunca volta para o campo: só o token fica guardado
        adminUserInput.value = credential?.username ?? adminUserInput.value;
        adminKeyInput.value = '';
        (adminUserInput.value ? adminKeyInput : adminUserInput).focus();
    } else {
        adminKeyInput.value = credential?.type === 'key' ? credential.value : '';
        adminKeyInput.focus();
    }
}

on('admin', () => {
    renderAdminButton();
    syncAdminViews();
    toggleAdminPopover(false);
    // Saiu do admin estando numa tela de admin: show() volta para a inicial
    if (!isAdmin()) show(currentView(), { notify: false });
    else refreshCurrent();
});

on('admin-rejected', () => showToast('A chave de admin foi recusada pelo servidor. Entre de novo.', 'error'));

adminBtn.addEventListener('click', event => {
    event.stopPropagation();
    toggleAdminPopover();
});
$('adminForm').addEventListener('submit', async event => {
    event.preventDefault();
    const secret = adminKeyInput.value;
    // Espera a config: enviado antes de ela chegar, a senha do Cognito seria
    // guardada como X-Api-Key
    const mode = authConfig.mode;
    if ((await syncAuthConfig()).mode !== mode) return showToast('Formulário de login atualizado: preencha de novo.', 'info');
    if (authConfig.mode !== 'cognito') {
        const value = secret.trim();
        if (!value) {
            setCredential(null);
            return showToast('Chave de admin removida.', 'info');
        }
        // Só guarda a chave que o servidor aceita: o selo "Admin ativo" não
        // aparece com uma chave que as telas de admin vão recusar
        const valid = await checkAdminKey(value);
        if (valid === false) return showToast('Chave de admin recusada pelo servidor.', 'error');
        setCredential({ type: 'key', value });
        showToast(valid ? 'Chave de admin ativa.' : 'Chave guardada, mas não deu para conferir no servidor agora.', 'info');
        return;
    }
    const username = adminUserInput.value.trim();
    if (!username || !secret) return showToast('Informe usuário e senha.', 'info');
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
        setCredential({ type: 'cognito', username, ...(await login(authConfig, username, secret)) });
        showToast('Login de admin feito.', 'info');
    } catch (error) {
        showToast(`Não foi possível entrar: ${error.message}.`, 'error');
    } finally {
        adminKeyInput.value = '';
        if (submit) submit.disabled = false;
    }
});
$('adminLogout').addEventListener('click', () => {
    const credential = getCredential();
    // Invalida o refresh token no Cognito; falhar aqui não impede sair
    if (credential?.type === 'cognito' && authConfig.mode === 'cognito') {
        revoke(authConfig, credential.refreshToken).catch(() => {});
    }
    setCredential(null);
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
renderAdminForm();
syncAuthConfig();
// Chave guardada nesta aba (sessionStorage) pode ter sido trocada no servidor
// desde então: confere antes de manter o selo "Admin ativo"
if (getCredential()?.type === 'key') {
    const stored = getCredential();
    checkAdminKey(stored.value).then(valid => {
        if (valid !== false || getCredential() !== stored) return;
        setCredential(null);
        showToast('A chave de admin guardada foi recusada pelo servidor. Entre de novo.', 'error');
    });
}
initRouter();
// O indicador do topo vale em qualquer tela; no Monitoramento o refresh já roda
if (currentView() !== 'monitoring') runMonitors();
if (currentView() !== 'chaos') loadChaos();
// Aba oculta pula a rodada: várias abas esquecidas não somam consultas
setInterval(() => {
    if (document.hidden) return;
    runMonitors();
    loadChaos();
}, 30000);
