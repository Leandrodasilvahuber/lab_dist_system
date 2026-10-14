import { icon } from './icons.js';

// Chance de cada tentativa de chamada falhar por throttling (metade, segundo o
// relato da equipe). É uma suposição, não uma medição: troque aqui quando
// houver dados reais de ACTION_FAILED ou do histórico do Step Functions.
const FALHA_POR_TENTATIVA = 0.5;

// Tentativas totais por passo, conforme o Retry do saga-workflow.asl.json:
// throttling da Lambda (1 + 6) e erro transitório (1 + 3 na cobrança, 1 + 5 no reembolso)
const PASSOS = [
    { nome: 'Cobrança', caso: 'throttling da Lambda', tentativas: 7 },
    { nome: 'Cobrança', caso: 'erro transitório da AWS', tentativas: 4 },
    { nome: 'Reembolso', caso: 'throttling da Lambda', tentativas: 7 },
    { nome: 'Reembolso', caso: 'erro transitório da AWS', tentativas: 6 }
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
    return PASSOS.map(({ nome, caso, tentativas }) => `
        <tr>
            <td>${nome}</td>
            <td>${caso}</td>
            <td class="num">${tentativas}</td>
            <td class="num"><strong>${percentual(chanceDeEsgotar(tentativas))}</strong></td>
        </tr>`).join('');
}

let dialog = null;

function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'modal modal-wide';
    dialog.setAttribute('aria-labelledby', 'reliabilityModalTitle');
    dialog.innerHTML = `
        <header class="modal-head">
            <div class="modal-title">
                <h2 id="reliabilityModalTitle">${icon('alert', { size: 18 })}<span>Pagamento e reembolso instáveis</span></h2>
                <span class="modal-sub">Aviso para quem usa o dashboard</span>
            </div>
        </header>
        <div class="modal-body reliability-body">
            <p>A confirmação do pedido falha depois da cobrança, e o reembolso falha cerca de metade das vezes. Hoje as falhas são absorvidas por retries: a compra conclui, mas pode demorar e a instabilidade fica escondida.</p>
            <p>Chance estimada de uma etapa esgotar todas as tentativas e cair na compensação (<strong>${percentual(FALHA_POR_TENTATIVA * 100)}</strong> de falha por tentativa, valor suposto):</p>
            <div class="table-wrap">
                <table class="reliability-table">
                    <thead>
                        <tr><th>Etapa</th><th>Tipo de falha</th><th class="num">Tentativas</th><th class="num">Chance de esgotar</th></tr>
                    </thead>
                    <tbody>${linhas()}</tbody>
                </table>
            </div>
            <p class="reliability-note">Estimativa calculada, não medida. Quando o reembolso esgota as tentativas, a saga vai para <span class="mono">COMPENSATION_FAILED</span> e exige correção manual.</p>
            <div class="reliability-actions">
                <button type="button" class="btn btn-primary" data-close>Entendi, fechar</button>
            </div>
        </div>`;
    // Obriga a fechar: só o botão fecha. Clique no fundo e Esc são bloqueados
    dialog.addEventListener('cancel', event => event.preventDefault());
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    document.body.append(dialog);
    return dialog;
}

/** Abre o aviso bloqueante: só fecha pelo botão. */
export function showReliabilityNotice() {
    const modal = ensureDialog();
    if (!modal.open) modal.showModal();
}
