import { describe, it } from 'node:test';
import assert from 'node:assert';

const { productIcon, productKind, PRODUCT_KINDS } = await import('../../../dashboard/js/components/product-icons.js');

describe('dashboard: ícones dos produtos', () => {
  it('reconhece frutas em inglês e português, com ou sem acento', () => {
    assert.strictEqual(productKind('Apple'), 'apple');
    assert.strictEqual(productKind('Maçã'), 'apple');
    assert.strictEqual(productKind('Pineapple'), 'pineapple');
    assert.strictEqual(productKind('Abacaxi'), 'pineapple');
    assert.strictEqual(productKind('Uva verde'), 'grape');
    assert.strictEqual(productKind('Pêra'), 'pear');
  });

  it('nome parecido mas de outro produto cai na caixinha', () => {
    for (const name of ['Macarrão', 'Macadâmia', 'Grapefruit', 'Pearl', undefined, '']) {
      assert.strictEqual(productKind(name), 'box', String(name));
    }
  });

  it('todo tipo renderiza em todos os humores, sem undefined', () => {
    for (const kind of PRODUCT_KINDS) {
      for (const mood of ['happy', 'joy', 'sad', 'wow', 'sleep']) {
        const svg = productIcon(kind, { mood });
        assert.match(svg, new RegExp(`^<svg class="pico pico-${kind}`));
        assert.doesNotMatch(svg, /undefined|NaN/, `${kind}/${mood}`);
      }
    }
  });

  it('o clipPath do abacaxi tem id único por instância', () => {
    const ids = [productIcon('abacaxi'), productIcon('abacaxi')]
      .map(svg => svg.match(/clipPath id="([^"]+)"/)[1]);
    assert.notStrictEqual(ids[0], ids[1]);
    for (const [i, svg] of [productIcon('abacaxi')].entries()) {
      const id = svg.match(/clipPath id="([^"]+)"/)[1];
      assert.ok(svg.includes(`url(#${id})`), `referência ${i}`);
    }
  });

  it('o nome do produto nunca vai para o HTML', () => {
    assert.doesNotMatch(productIcon('<img src=x onerror=alert(1)>'), /onerror|<img/);
  });
});
