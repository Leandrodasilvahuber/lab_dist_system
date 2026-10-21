// Toda página abre no tema escuro, aplicado antes do primeiro paint (sem piscar o claro).
// O botão de tema troca só durante a visita. Script clássico e síncrono no <head>, antes do CSS
document.documentElement.dataset.theme = 'dark';
