import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { icon } from '../components/icons.js';
import { panel } from '../components/layout.js';

// Os SVGs ficam em diagramas/ na raiz do projeto (fonte única, com o README);
// o local-server e o deploy os servem neste caminho
export const DIAGRAMS_BASE = '/dashboard/diagramas/';

export const DIAGRAMS = [
    {
        id: 'arquitetura-e-saga',
        title: 'Arquitetura e saga de compra',
        icon: 'workflow',
        summary: 'Serviços, tabelas por serviço, eventos e o Step Functions; embaixo, o fluxo da compra com a compensação de cada passo.'
    },
    {
        id: 'api-e-telas',
        title: 'API, telas e exposição',
        icon: 'link',
        summary: 'Todas as rotas do HttpApi por Lambda, quais exigem login no Cognito, os limites diários e o que só é invocado por dentro da AWS.'
    },
    {
        id: 'observabilidade',
        title: 'Observabilidade e resiliência',
        icon: 'activity',
        summary: 'Da linha de log JSON (EMF) às métricas, alarmes e SLOs; as abas deste dashboard; circuit breaker, DLQ e caos.'
    },
    {
        id: 'deploy-e-custo',
        title: 'Entrega, site e custo',
        icon: 'dollar',
        summary: 'CI/CD com GitHub Actions (OIDC), deploy.sh, CloudFront + S3 e as camadas de proteção de custo.'
    }
];

export const diagramUrl = diagram => `${DIAGRAMS_BASE}${diagram.id}.svg`;

let selected = DIAGRAMS[0].id;
// Ajustado à largura (padrão) ou no tamanho real, com rolagem
let actualSize = false;

export default {
    id: 'diagrams',
    label: 'Diagramas',
    icon: 'layers',
    template: () => `
        <div class="diagram-tabs" role="tablist" aria-label="Diagramas">
            ${DIAGRAMS.map(d => `
                <button type="button" class="btn btn-secondary btn-sm" role="tab" id="diagramTab-${d.id}"
                    data-diagram="${d.id}" aria-controls="diagramPanel">
                    ${icon(d.icon, { size: 15 })}<span>${escapeHtml(d.title)}</span>
                </button>`).join('')}
        </div>
        <div id="diagramPanel" role="tabpanel">
            ${panel({
                title: ' ',
                icon: 'layers',
                actions: `
                    <button type="button" class="btn btn-ghost btn-sm" id="diagramZoom" aria-pressed="false">${icon('search', { size: 15 })}<span>Tamanho real</span></button>
                    <a class="btn btn-secondary btn-sm" id="diagramOpen" target="_blank" rel="noopener">${icon('arrowRight', { size: 15 })}<span>Abrir em nova aba</span></a>`,
                body: `
                    <p class="diagram-summary" id="diagramSummary"></p>
                    <div class="diagram-frame" id="diagramFrame">
                        <img id="diagramImage" alt="" decoding="async">
                    </div>`
            })}
        </div>`,

    mount() {
        document.querySelectorAll('[data-diagram]').forEach(button => {
            button.addEventListener('click', () => {
                selected = button.dataset.diagram;
                render();
            });
        });
        $('diagramZoom').addEventListener('click', () => {
            actualSize = !actualSize;
            render();
        });
        render();
    },

    refresh: render
};

function render() {
    const diagram = DIAGRAMS.find(d => d.id === selected) || DIAGRAMS[0];
    document.querySelectorAll('[data-diagram]').forEach(button => {
        button.setAttribute('aria-selected', String(button.dataset.diagram === diagram.id));
    });
    const panelEl = $('diagramPanel');
    panelEl.setAttribute('aria-labelledby', `diagramTab-${diagram.id}`);
    panelEl.querySelector('.panel-head h2').innerHTML = `${icon(diagram.icon, { size: 17 })}<span>${escapeHtml(diagram.title)}</span>`;
    $('diagramSummary').textContent = diagram.summary;

    const url = diagramUrl(diagram);
    const image = $('diagramImage');
    if (image.getAttribute('src') !== url) image.src = url;
    image.alt = `Diagrama: ${diagram.title}`;
    $('diagramOpen').href = url;

    $('diagramFrame').classList.toggle('is-actual', actualSize);
    const zoom = $('diagramZoom');
    zoom.setAttribute('aria-pressed', String(actualSize));
    zoom.querySelector('span').textContent = actualSize ? 'Ajustar à largura' : 'Tamanho real';
}
