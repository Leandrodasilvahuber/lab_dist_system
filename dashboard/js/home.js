// Botão de tema da página inicial. O tema em si (padrão claro) é aplicado
// antes do primeiro paint por js/theme-init.js; a escolha usa a mesma chave
// 'theme' do dashboard, então vale para as duas páginas.
const btn = document.getElementById('themeBtn');
const root = document.documentElement;

function render() {
    const dark = root.dataset.theme === 'dark';
    btn.textContent = dark ? '☀️' : '🌙';
    btn.title = dark
        ? 'Tema claro: fundo branco, melhor com bastante luz. Clique para voltar ao claro.'
        : 'Tema escuro: fundo escuro que cansa menos a vista em ambientes com pouca luz. Clique para ativar.';
    btn.setAttribute('aria-label', btn.title);
}

btn.addEventListener('click', () => {
    const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = theme;
    try { localStorage.setItem('theme', JSON.stringify(theme)); } catch { /* sem storage: vale só nesta visita */ }
    render();
});
render();
