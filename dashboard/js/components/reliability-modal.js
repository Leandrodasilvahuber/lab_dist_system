import { icon } from './icons.js';

// Chance de cada tentativa de chamada falhar por throttling (metade, segundo o
// relato da equipe). É uma suposição, não uma medição: troque aqui quando
// houver dados reais de ACTION_FAILED ou do histórico do Step Functions.
const FALHA_POR_TENTATIVA = 0.5;

// Tentativas totais da cobrança (ProcessPayment), conforme o Retry do
// saga-workflow.asl.json: throttling da Lambda (1 + 6) e erro transitório (1 + 3)
const PASSOS = [
    { caso: 'Throttling da Lambda', tentativas: 7 },
    { caso: 'Erro transitório', tentativas: 4 }
];

// Chance de todas as tentativas falharem: p^n
function chanceDeEsgotar(tentativas) {
    return FALHA_POR_TENTATIVA ** tentativas * 100;
}

function percentual(valor) {
    const texto = valor < 0.1 ? valor.toFixed(2) : valor.toFixed(1);
    return `${texto.replace('.', ',')}%`;
}

function linhas() {
    return PASSOS.map(({ caso, tentativas }) => `
        <tr>
            <td>${caso}</td>
            <td class="num">${tentativas}</td>
            <td class="num"><strong>${percentual(chanceDeEsgotar(tentativas))}</strong></td>
        </tr>`).join('');
}

let dialog = null;

function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'modal modal-wide tone-warn';
    dialog.setAttribute('aria-labelledby', 'reliabilityModalTitle');
    dialog.innerHTML = `
        <header class="modal-head">
            <div class="modal-title">
                <h2 id="reliabilityModalTitle">${icon('alert', { size: 18 })}<span>Pagamento instável</span></h2>
                <span class="modal-sub">Confirme antes de ligar o experimento</span>
            </div>
        </header>
        <div class="modal-body reliability-body">
            <p>${percentual(FALHA_POR_TENTATIVA * 100)} das cobranças falham. O Step Functions repete a cobrança e a compra costuma concluir, só que mais devagar.</p>
            <p>Chance de a cobrança esgotar as tentativas (<strong>${percentual(FALHA_POR_TENTATIVA * 100)}</strong> de falha em cada uma):</p>
            <div class="table-wrap">
                <table class="reliability-table">
                    <thead>
                        <tr><th>Tipo de falha</th><th class="num">Tentativas</th><th class="num">Chance de esgotar</th></tr>
                    </thead>
                    <tbody>${linhas()}</tbody>
                </table>
            </div>
            <p class="reliability-note">Estimativa, não medição. Se esgotar, a compra é desfeita (<span class="mono">COMPENSATED</span>): pedido cancelado e estoque devolvido.</p>
            <p class="callout callout-warn" id="reliabilityReplace" hidden>As falhas ativas serão substituídas por este experimento.</p>
            <div class="modal-actions reliability-actions">
                <button type="button" class="btn btn-secondary" data-answer="no">Cancelar</button>
                <button type="button" class="btn btn-primary" data-answer="yes">${icon('zap', { size: 15 })}<span>Ligar experimento</span></button>
            </div>
        </div>`;
    // Esc, clique no fundo e Cancelar não ligam o experimento
    dialog.addEventListener('click', event => {
        const answer = event.target.closest('[data-answer]')?.dataset.answer;
        if (answer) dialog.close(answer);
        else if (event.target === dialog) dialog.close('no');
    });
    dialog.addEventListener('close', () => {
        settle?.(dialog.returnValue === 'yes');
        settle = null;
    });
    document.body.append(dialog);
    return dialog;
}

let settle = null;

/**
 * Confirmação antes de ligar o experimento de pagamento instável: mostra a
 * chance de a cobrança esgotar os retries. replacing: já há falhas ativas,
 * que serão substituídas. Devolve Promise<boolean>.
 */
export function confirmReliability({ replacing = false } = {}) {
    const modal = ensureDialog();
    settle?.(false);
    modal.returnValue = '';
    modal.querySelector('#reliabilityReplace').hidden = !replacing;
    if (!modal.open) modal.showModal();
    modal.querySelector('[data-answer="yes"]').focus();
    return new Promise(resolve => { settle = resolve; });
}
