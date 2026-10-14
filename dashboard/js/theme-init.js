// Tema escolhido (padrão: claro) antes do primeiro paint (sem piscar o claro no modo escuro).
// Script clássico e síncrono no <head> do index.html, antes do CSS
try {
    const theme = JSON.parse(localStorage.getItem('theme'));
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
} catch { document.documentElement.dataset.theme = 'light'; }
