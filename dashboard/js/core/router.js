import { DEFAULT_VIEW, GROUPS } from '../views/index.js';
import { icon } from '../components/icons.js';
import { $ } from './dom.js';
import { escapeHtml } from './format.js';
import { setNavigator } from './nav.js';
import { isAdmin } from './session.js';
import { showToast } from '../components/toast.js';

// Monta a navegação e todas as telas uma vez; trocar de tela só mostra/esconde
// e chama refresh(). A tela atual fica no hash (#/slo), então recarregar ou
// voltar no navegador mantém a aba
const views = new Map();
let current = null;

const fromHash = () => location.hash.replace(/^#\/?/, '') || DEFAULT_VIEW;

export function initRouter() {
    $('nav').innerHTML = GROUPS.map(group => `
        <div class="nav-group" data-group="${group.id}">
            <div class="nav-group-title">${escapeHtml(group.label)}</div>
            <ul class="nav-list">${group.views.map(view => `
                <li data-view="${view.id}">
                    <a class="nav-link" href="#/${view.id}" data-nav="${view.id}">
                        ${icon(view.icon)}<span>${escapeHtml(view.label)}</span>
                        ${view.requiresAdmin ? `<span class="nav-lock">${icon('lock', { size: 13 })}</span>` : ''}
                    </a>
                </li>`).join('')}
            </ul>
        </div>`).join('');

    const container = $('views');
    for (const group of GROUPS) {
        for (const view of group.views) {
            const section = document.createElement('section');
            section.className = 'view';
            section.id = `view-${view.id}`;
            section.hidden = true;
            section.innerHTML = view.template();
            container.append(section);
            views.set(view.id, { ...view, group });
        }
    }
    for (const view of views.values()) view.mount?.();

    setNavigator(navigate);
    window.addEventListener('popstate', () => show(fromHash()));
    syncAdminViews();
    show(fromHash());
}

export const currentView = () => current?.id;

export function navigate(name) {
    if (fromHash() !== name || !location.hash) history.pushState(null, '', `#/${name}`);
    show(name);
}

export function refreshCurrent() {
    return current?.refresh?.();
}

// Telas de admin só aparecem no menu (e nos atalhos de outras telas, como o
// "Logs de erro" do Monitoramento) com a chave ativa
export function syncAdminViews() {
    const hasKey = isAdmin();
    for (const view of views.values()) {
        if (!view.requiresAdmin) continue;
        document.querySelector(`.nav-list [data-view="${view.id}"]`).hidden = !hasKey;
        document.querySelectorAll(`.link-btn[data-nav="${view.id}"]`).forEach(link => { link.hidden = !hasKey; });
    }
}

// `notify: false`: quem chama já avisou (ex.: saiu do modo admin)
export function show(name, { notify = true } = {}) {
    let view = views.get(name) || views.get(DEFAULT_VIEW);
    if (view.requiresAdmin && !isAdmin()) {
        if (notify) showToast(`${view.label} exige login de admin (botão no canto superior direito).`, 'info');
        view = views.get(DEFAULT_VIEW);
    }
    if (fromHash() !== view.id) history.replaceState(null, '', `#/${view.id}`);
    current = view;

    for (const { id } of views.values()) $(`view-${id}`).hidden = id !== view.id;
    document.querySelectorAll('.nav-link').forEach(link => {
        if (link.dataset.nav === view.id) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    });

    // Cabeçalho da página na cor do grupo
    document.querySelector('.main').dataset.group = view.group.id;
    $('pageIcon').innerHTML = icon(view.icon, { size: 20 });
    $('pageGroup').textContent = view.group.label;
    $('pageTitle').textContent = view.label;
    document.title = `${view.label} · E-commerce Dashboard`;
    window.scrollTo({ top: 0 });

    view.refresh?.();
}
