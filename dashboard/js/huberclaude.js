// Idioma (js/i18n.js, traduções em js/huberclaude-i18n.js) e botões "Copiar" do site do HüberClaude.
import { createI18n } from './i18n.js';
import { DICT } from './huberclaude-i18n.js';

const i18n = createI18n({ dict: DICT });

document.querySelectorAll('[data-copy]').forEach(button => {
    button.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(button.dataset.copy);
        } catch {
            // Sem permissão ou sem HTTPS: seleciona o texto para o usuário copiar na mão
            const target = button.closest('.pix, .install')?.querySelector('code');
            if (target) window.getSelection().selectAllChildren(target);
            return;
        }
        const label = button.textContent;
        button.textContent = i18n.t('copy.done');
        setTimeout(() => { button.textContent = label; }, 1600);
    });
});
