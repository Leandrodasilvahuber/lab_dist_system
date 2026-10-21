// Troca de idioma (pt, en, es) das páginas públicas. O HTML da Lambda vem em
// português (reserva sem JS); aqui o texto é trocado pelos atributos:
//   data-i18n (texto), data-i18n-title / -alt / -content / -aria-label,
//   data-src-pt|en|es (imagem por idioma) e data-href-pt|en|es (link por idioma).
// As traduções vêm de um dicionário { en: {...}, es: {...} } (e 'pt' só com o que o
// JS escreve depois do carregamento). A página sempre abre em português; a
// bandeira troca o idioma só durante a visita.
const ATTRS = [['i18n-title', 'title'], ['i18n-alt', 'alt'], ['i18n-content', 'content'], ['i18n-aria-label', 'aria-label']];
export const LANGS = ['pt', 'en', 'es'];
const HTML_LANG = { pt: 'pt-BR', en: 'en', es: 'es' };

export function createI18n({ dict, onChange = () => {} }) {
    let lang = 'pt';
    // Texto original (português) guardado na primeira troca, para poder voltar a ele
    const original = new Map();

    const t = key => dict[lang]?.[key] ?? dict.pt?.[key];

    function apply(el, key, attr) {
        const slot = attr ?? '#text';
        if (!original.has(el)) original.set(el, {});
        const saved = original.get(el);
        if (!(slot in saved)) saved[slot] = attr ? el.getAttribute(attr) : el.textContent;
        const value = lang === 'pt' ? saved[slot] : dict[lang]?.[key] ?? saved[slot];
        if (attr) el.setAttribute(attr, value); else el.textContent = value;
    }

    function setLang(next) {
        lang = LANGS.includes(next) ? next : 'pt';
        document.documentElement.lang = HTML_LANG[lang];
        document.querySelectorAll('[data-i18n]').forEach(el => apply(el, el.dataset.i18n));
        for (const [data, attr] of ATTRS) {
            const dataAttr = `data-${data}`;
            document.querySelectorAll(`[${dataAttr}]`).forEach(el => apply(el, el.getAttribute(dataAttr), attr));
        }
        document.querySelectorAll('[data-src-pt]').forEach(img => { img.src = img.getAttribute(`data-src-${lang}`) ?? img.getAttribute('data-src-pt'); });
        document.querySelectorAll('[data-href-pt]').forEach(a => { a.href = a.getAttribute(`data-href-${lang}`) ?? a.getAttribute('data-href-pt'); });
        if (!original.has(document)) original.set(document, document.title);
        document.title = dict[lang]?.['meta.title'] ?? original.get(document);
        document.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
        onChange(lang);
    }

    document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));
    setLang('pt');
    return { t, setLang };
}
