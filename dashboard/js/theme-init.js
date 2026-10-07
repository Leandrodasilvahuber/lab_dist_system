// Tema escolhido antes do primeiro paint (sem piscar o claro no modo escuro).
// Script clássico e síncrono no <head> do index.html, antes do CSS
try {
    const theme = JSON.parse(localStorage.getItem('theme'));
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* sem storage: segue o sistema */ }
