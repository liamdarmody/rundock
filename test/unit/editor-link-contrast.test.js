'use strict';
// Every colour a link in a note is drawn in, measured in both themes from the
// real tokens and the real stylesheet: links in the properties panel, the
// words around them, and links in the note body, resolved and missing.
//
// Nothing here is a number typed beside a token. Each row names a rule in
// public/styles/views/editor.css and the property carrying the colour; the
// test reads that declaration (a `body.light` variant wins in light, as it
// does on the page), resolves it against tokens.css, and computes the WCAG 2
// ratio against the surface the link actually sits on. The panel is drawn on
// --card; the note body on the main pane's --elevated.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

function tokens() {
  const css = read('public/styles/tokens.css');
  const block = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start !== -1, `tokens.css has no ${selector} block`);
    return new Map([...css.slice(start, css.indexOf('}', start)).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const dark = block(':root');
  return { dark, light: new Map([...dark, ...block('body.light')]) };
}

// selector -> declarations, outside @media blocks (none of which colour a link).
function rules(rel) {
  const css = read(rel).replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const map = new Map();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    for (const sel of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      map.set(sel, new Map([...(map.get(sel) || []), ...decls]));
    }
  }
  return map;
}

function rgb(value, theme, where) {
  const token = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (token) {
    assert.ok(theme.has(token[1]), `${where} reads ${token[1]}, which tokens.css does not declare`);
    return rgb(theme.get(token[1]), theme, `${where} via ${token[1]}`);
  }
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  assert.ok(m, `${where} resolves to ${value}, not a six-digit hex`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(c) {
  const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const THEMES = tokens();
const EDITOR = rules('public/styles/views/editor.css');
const BASE = rules('public/styles/base.css');

function declared(sheet, selector, property, themeName, lightSelector = `body.light ${selector}`) {
  if (themeName === 'light' && sheet.get(lightSelector) && sheet.get(lightSelector).has(property)) {
    return sheet.get(lightSelector).get(property);
  }
  const rule = sheet.get(selector);
  assert.ok(rule && rule.has(property), `no ${property} on ${selector}; if the rule moved, move this row with it`);
  return rule.get(property);
}

const PANEL = ['.tiptap-editor-pane .properties', 'background', BASE];
const PAGE = ['.main', 'background', BASE];
const LINK = '.tiptap-editor-pane .prop-wikilink';
const PAIRINGS = [
  // [label, [selector, property, light variant], background]
  ['panel link to a note that exists', [LINK, 'color', `body.light ${LINK}:not(.dead)`], PANEL],
  ['panel link to a missing note', [`${LINK}.dead`, 'color'], PANEL],
  ['words around panel links', ['.tiptap-editor-pane .prop-value', 'color'], PANEL],
  ['body link to a note that exists', ['.tiptap-editor .ProseMirror a.wikilink', 'color'], PAGE],
];

describe('link colours in a note clear 4.5:1 in both themes', () => {
  for (const [label, [selector, property, lightSel], [bgSel, bgProp]] of PAIRINGS) {
    for (const name of ['dark', 'light']) {
      test(`${label}, ${name}`, () => {
        const theme = THEMES[name];
        const fg = rgb(declared(EDITOR, selector, property, name, lightSel), theme, selector);
        const bgSheet = bgSel === '.main' ? BASE : EDITOR;
        const bg = rgb(declared(bgSheet, bgSel, bgProp, name), theme, bgSel);
        const r = ratio(fg, bg);
        assert.ok(r >= 4.5, `${label} in ${name} measures ${r.toFixed(2)}:1, needs 4.5`);
      });
    }
  }
});

describe('a link is told apart by more than colour', () => {
  test('a panel link is underlined, and a missing one dashed, at full strength', () => {
    assert.match(EDITOR.get(LINK).get('text-decoration'), /underline/);
    assert.match(EDITOR.get(`${LINK}.dead`).get('text-decoration-style'), /dashed/);
    assert.ok(!EDITOR.get(`${LINK}.dead`).has('opacity'), 'opacity would lower the measured contrast');
  });

  test('the pencil is hidden by opacity, so it stays in the tab order', () => {
    const pencil = EDITOR.get('.prop-wikilink-edit');
    assert.notStrictEqual(pencil.get('display'), 'none');
    assert.strictEqual(pencil.get('opacity'), '0');
    const raw = read('public/styles/views/editor.css');
    assert.match(raw, /\.prop-row\.editable:focus-within \.prop-wikilink-edit/, 'shown when focus is inside the row');
    assert.match(raw, /@media \(hover: none\)\s*\{[^}]*\.prop-wikilink-edit[^}]*opacity: 1/, 'always shown where nothing hovers');
  });
});
