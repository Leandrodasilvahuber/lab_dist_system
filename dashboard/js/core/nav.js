// Navegação entre telas sem import circular: o router registra a implementação
let impl = () => {};

export function navigate(name) {
    impl(name);
}

export function setNavigator(fn) {
    impl = fn;
}
