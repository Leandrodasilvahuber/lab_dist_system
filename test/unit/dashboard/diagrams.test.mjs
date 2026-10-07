import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIAGRAMS, diagramUrl } from '../../../dashboard/js/views/diagrams.js';

const DIAGRAMS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../diagramas');

test('aba Diagramas: cada diagrama tem o SVG em diagramas/', () => {
  for (const diagram of DIAGRAMS) {
    assert.ok(fs.existsSync(path.join(DIAGRAMS_DIR, `${diagram.id}.svg`)), `${diagram.id}.svg não existe em diagramas/`);
    assert.equal(diagramUrl(diagram), `/dashboard/diagramas/${diagram.id}.svg`);
  }
});

test('aba Diagramas: todo SVG de diagramas/ aparece na aba', () => {
  const svgs = fs.readdirSync(DIAGRAMS_DIR).filter(f => f.endsWith('.svg')).map(f => f.slice(0, -4)).sort();
  assert.deepEqual(DIAGRAMS.map(d => d.id).sort(), svgs);
});
