// Ícones fofos dos produtos (SVG inline, 64x64, com carinha). O sistema vende
// frutas: cada uma tem o seu; o que não for reconhecido vira uma caixinha de
// presente. Sem dependências: o arquivo também roda no Node (testes)

const INK = '#3d2c2c';
const LEAF = '#6fd68a';
const STEM = '#8a5a3c';

// Carinha: happy (padrão), joy (olhos fechados, sorrindo), sad, wow e sleep
function face(x, y, { gap = 7, mood = 'happy' } = {}) {
    const l = x - gap;
    const r = x + gap;
    const eye = (cx, closed) => closed
        ? `<path d="M${cx - 2.6} ${y + 1}q2.6 -3.6 5.2 0" stroke="${INK}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`
        : `<circle cx="${cx}" cy="${y}" r="2.5" fill="${INK}"/><circle cx="${cx - 0.8}" cy="${y - 0.9}" r="0.85" fill="#fff"/>`;
    const sleepEye = cx => `<path d="M${cx - 2.6} ${y}q2.6 2.4 5.2 0" stroke="${INK}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`;
    const eyes = mood === 'joy' ? eye(l, true) + eye(r, true)
        : mood === 'sleep' ? sleepEye(l) + sleepEye(r)
            : eye(l) + eye(r);
    const mouthY = y + 4.5;
    const mouth = {
        happy: `<path d="M${x - 3} ${mouthY}q3 3.2 6 0" stroke="${INK}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`,
        joy: `<path d="M${x - 3.6} ${mouthY - 0.5}q3.6 6 7.2 0z" fill="${INK}"/>`,
        sad: `<path d="M${x - 3} ${mouthY + 2.4}q3 -3.2 6 0" stroke="${INK}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`,
        wow: `<ellipse cx="${x}" cy="${mouthY + 1}" rx="1.9" ry="2.4" fill="${INK}"/>`,
        sleep: `<path d="M${x - 2} ${mouthY + 0.5}q2 1.8 4 0" stroke="${INK}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
    }[mood] || '';
    const blush = `<ellipse cx="${l - 3.4}" cy="${y + 4.2}" rx="3" ry="1.9" fill="#ff8fab" opacity=".6"/><ellipse cx="${r + 3.4}" cy="${y + 4.2}" rx="3" ry="1.9" fill="#ff8fab" opacity=".6"/>`;
    return `<g>${blush}${eyes}${mouth}</g>`;
}

const shine = (x, y, rx = 2.6, ry = 6, rot = -15) =>
    `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="#fff" opacity=".4" transform="rotate(${rot} ${x} ${y})"/>`;
const leaf = (d, fill = LEAF) => `<path d="${d}" fill="${fill}"/>`;

const ICONS = {
    apple: mood => `
        <path d="M32 21c-6-5-19-3-19 12 0 13 8 24 19 24s19-11 19-24c0-15-13-17-19-12z" fill="#ff6b7a"/>
        ${shine(20, 33)}
        <path d="M32 21c0-5 1-9 5-12" stroke="${STEM}" stroke-width="3.2" stroke-linecap="round" fill="none"/>
        ${leaf('M36 14c2-5 9-6 13-3-2 6-9 7-13 3z')}
        ${face(32, 40, { mood })}`,

    banana: mood => `
        <path d="M44 12C48 34 36 48 16 53" stroke="#f2b92a" stroke-width="24" stroke-linecap="round" fill="none"/>
        <path d="M44 12C48 34 36 48 16 53" stroke="#ffdf55" stroke-width="20" stroke-linecap="round" fill="none"/>
        <path d="M50 20c-1 12-6 22-16 29" stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none" opacity=".45"/>
        <path d="M44 9v-3" stroke="#8a6a3c" stroke-width="7" stroke-linecap="round"/>
        ${face(39, 37, { gap: 5, mood })}`,

    grape: mood => `
        <path d="M32 20c0-6 2-9 7-11" stroke="${STEM}" stroke-width="3" stroke-linecap="round" fill="none"/>
        ${leaf('M37 14c2-5 9-6 13-3-2 6-9 7-13 3z')}
        <g fill="#a874ec" stroke="#8650d2" stroke-width="1.4">
            <circle cx="20" cy="29" r="9"/><circle cx="32" cy="27" r="9"/><circle cx="44" cy="29" r="9"/>
            <circle cx="26" cy="40" r="9"/><circle cx="38" cy="40" r="9"/><circle cx="32" cy="51" r="9"/>
        </g>
        <g fill="#fff" opacity=".45"><circle cx="17" cy="26" r="2"/><circle cx="29" cy="24" r="2"/><circle cx="41" cy="26" r="2"/></g>
        ${face(32, 38, { gap: 6, mood })}`,

    orange: mood => `
        <circle cx="32" cy="36" r="22" fill="#ffa24a"/>
        <path d="M18 24c3-5 8-8 13-8" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none" opacity=".4"/>
        <path d="M32 15c0-3 1-5 3-6" stroke="${STEM}" stroke-width="3" stroke-linecap="round" fill="none"/>
        ${leaf('M34 13c3-5 10-5 13-2-3 5-9 6-13 2z')}
        ${face(32, 38, { mood })}`,

    lemon: mood => `
        <ellipse cx="32" cy="36" rx="23" ry="18" fill="#ffe55f" transform="rotate(-18 32 36)"/>
        <circle cx="10" cy="43" r="3.2" fill="#ffe55f"/><circle cx="54" cy="29" r="3.2" fill="#ffe55f"/>
        <path d="M17 30c3-5 8-8 14-8" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none" opacity=".5"/>
        ${leaf('M33 17c3-5 10-5 13-2-3 5-9 6-13 2z')}
        ${face(32, 38, { mood })}`,

    strawberry: mood => `
        <path d="M32 57C14 47 9 32 14 24c4-6 12-6 18-3 6-3 14-3 18 3 5 8 0 23-18 33z" fill="#ff6b81"/>
        ${shine(19, 34, 2.4, 5)}
        <g fill="#ffe9a8"><ellipse cx="22" cy="46" rx="1.1" ry="1.7"/><ellipse cx="42" cy="46" rx="1.1" ry="1.7"/><ellipse cx="32" cy="51" rx="1.1" ry="1.7"/><ellipse cx="15" cy="33" rx="1.1" ry="1.7"/><ellipse cx="49" cy="33" rx="1.1" ry="1.7"/></g>
        ${leaf('M19 22l8-3 5-7 5 7 8 3-7 4 2 6-8-3-8 3 2-6z')}
        ${face(32, 40, { mood })}`,

    watermelon: mood => `
        <path d="M5 22a27 27 0 0 0 54 0z" fill="#ff6b81"/>
        <path d="M5 22a27 27 0 0 0 54 0" stroke="#4fbf76" stroke-width="6" fill="none" stroke-linecap="round"/>
        <path d="M9 24a23 23 0 0 0 46 0" stroke="#d6f5c9" stroke-width="2" fill="none" opacity=".8"/>
        <g fill="${INK}"><ellipse cx="17" cy="30" rx="1.3" ry="2" transform="rotate(20 17 30)"/><ellipse cx="47" cy="30" rx="1.3" ry="2" transform="rotate(-20 47 30)"/><ellipse cx="32" cy="46" rx="1.3" ry="2"/></g>
        ${face(32, 34, { mood })}`,

    pear: mood => `
        <path d="M32 11c-5 0-7 5-7 9 0 4-9 8-9 20 0 10 7 17 16 17s16-7 16-17c0-12-9-16-9-20 0-4-2-9-7-9z" fill="#b9e27c"/>
        ${shine(22, 42, 2.4, 6)}
        <path d="M32 11c0-3 1-5 3-6" stroke="${STEM}" stroke-width="3" stroke-linecap="round" fill="none"/>
        ${leaf('M34 8c3-4 9-4 12-1-3 5-8 5-12 1z')}
        ${face(32, 43, { mood })}`,

    cherry: mood => `
        <path d="M22 33c3-11 9-18 16-23M44 35c-2-10-4-17-6-25" stroke="${STEM}" stroke-width="2.6" stroke-linecap="round" fill="none"/>
        ${leaf('M38 10c3-5 10-5 14-1-3 5-10 6-14 1z')}
        <circle cx="21" cy="45" r="12" fill="#ff5470"/><circle cx="44" cy="47" r="12" fill="#ff6b84"/>
        <ellipse cx="16" cy="40" rx="2.2" ry="3.6" fill="#fff" opacity=".4"/><ellipse cx="39" cy="42" rx="2.2" ry="3.6" fill="#fff" opacity=".4"/>
        ${face(21, 46, { gap: 4.4, mood })}${face(44, 48, { gap: 4.4, mood })}`,

    peach: mood => `
        <path d="M32 19c-14-5-22 8-20 20 2 12 10 18 20 18s18-6 20-18c2-12-6-25-20-20z" fill="#ffb59f"/>
        <path d="M32 19c14-5 22 8 20 20-1 6-4 11-9 14" fill="#ff9d86" opacity=".4"/>
        ${shine(18, 36, 2.4, 6, 10)}
        <path d="M32 19c0-3 1-5 3-7" stroke="${STEM}" stroke-width="3" stroke-linecap="round" fill="none"/>
        ${leaf('M34 15c3-5 10-6 14-2-3 6-10 7-14 2z')}
        ${face(32, 40, { mood })}`,

    pineapple: mood => `
        <defs><clipPath id="pico-pine"><ellipse cx="32" cy="41" rx="17" ry="20"/></clipPath></defs>
        <path d="M32 22L22 6l8 6 2-10 2 10 8-6z" fill="#5fcf80"/>
        <path d="M24 24L16 12l9 6zM40 24l8-12-9 6z" fill="#7fdc9a"/>
        <ellipse cx="32" cy="41" rx="17" ry="20" fill="#ffcf4a"/>
        <g clip-path="url(#pico-pine)" stroke="#f0a830" stroke-width="1.6" opacity=".55" fill="none">
            <path d="M10 28l44 30M10 40l34 24M10 16l44 30M22 14l34 26M20 66l36-26M10 52l44-30"/>
        </g>
        ${face(32, 42, { mood })}`,

    kiwi: mood => `
        <circle cx="32" cy="34" r="24" fill="#a07a50"/>
        <circle cx="32" cy="34" r="20" fill="#92dc5e"/>
        <circle cx="32" cy="34" r="9.5" fill="#eaf8c8"/>
        <g fill="${INK}" opacity=".75">${Array.from({ length: 10 }, (_, i) => {
        const a = (i / 10) * Math.PI * 2;
        return `<ellipse cx="${(32 + Math.cos(a) * 14.5).toFixed(1)}" cy="${(34 + Math.sin(a) * 14.5).toFixed(1)}" rx="1" ry="1.7" transform="rotate(${(a * 180 / Math.PI + 90).toFixed(0)} ${(32 + Math.cos(a) * 14.5).toFixed(1)} ${(34 + Math.sin(a) * 14.5).toFixed(1)})"/>`;
    }).join('')}</g>
        ${face(32, 33, { gap: 4.6, mood })}`,

    server: mood => `
        <rect x="9" y="11" width="46" height="19" rx="7" fill="#b9c6ff"/>
        <rect x="9" y="34" width="46" height="19" rx="7" fill="#9bb0ff"/>
        <rect x="16" y="54" width="7" height="4" rx="2" fill="#7d93ee"/><rect x="41" y="54" width="7" height="4" rx="2" fill="#7d93ee"/>
        <circle cx="17" cy="43.5" r="2.4" fill="#6fe39a"/><circle cx="25" cy="43.5" r="2.4" fill="#ff8fab"/>
        <path d="M36 43.5h12" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".6"/>
        ${face(32, 19.5, { gap: 6, mood })}`,

    box: mood => `
        <rect x="12" y="27" width="40" height="27" rx="6" fill="#ff9ec0"/>
        <rect x="9" y="20" width="46" height="12" rx="5" fill="#ff7fae"/>
        <rect x="29" y="20" width="6" height="34" fill="#ffe27a"/>
        <path d="M32 20c-6-11-15-6-11-2.5s11 2.5 11 2.5zM32 20c6-11 15-6 11-2.5s-11 2.5-11 2.5z" fill="#ffe27a"/>
        ${face(32, 43, { gap: 11, mood })}`
};

// Nome do produto -> ícone (sem acento, minúsculas; inglês e português)
const MATCH = [
    ['pineapple', /pineapple|abacaxi/], ['apple', /apple|maca/], ['banana', /banana/], ['grape', /grape|uva/], ['orange', /orange|laranja|tangerina|mexerica/],
    ['lemon', /lemon|limao/], ['strawberry', /strawberr|morango/], ['watermelon', /watermelon|melancia/],
    ['pear', /pear|pera\b/], ['cherry', /cherr|cereja/], ['peach', /peach|pessego/],
    ['kiwi', /kiwi/], ['server', /server|servidor/]
];

export function productKind(name) {
    const text = String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    return MATCH.find(([, pattern]) => pattern.test(text))?.[0] || 'box';
}

/** SVG do produto. mood: happy | joy | sad | wow | sleep */
export function productIcon(name, { size = 40, mood = 'happy', className = '' } = {}) {
    const kind = productKind(name);
    return `<svg class="pico pico-${kind}${className ? ` ${className}` : ''}" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">${ICONS[kind](mood)}</svg>`;
}

export const PRODUCT_KINDS = Object.keys(ICONS);
