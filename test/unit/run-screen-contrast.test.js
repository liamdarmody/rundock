'use strict';
// Every color the run screen gives a changed file's link, the notes about
// its file list, and Stop, measured in both themes from the real tokens and
// the real run screen stylesheet.
//
// Each row names a rule in public/styles/views/run-detail.css and the
// property carrying the color, resolves it through tokens.css for the theme,
// and computes the WCAG 2 ratio against the surface it is drawn on. Text is
// held to 4.5:1, a focus ring and a control's edge to 3:1.
//
// RESOLVED AS THE BROWSER RESOLVES IT, which is the one thing this file adds
// to the resolvers beside it. A custom property is computed on the element
// that declares it, and its var() references are read there. --link-text is
// a mix of --accent-text and --text-1; declared only on :root, it is computed
// once with the dark values and body.light inherits that result, so a light
// link would draw in a dark-theme color. A resolver that merged the two
// blocks into one table would read the light values into it and pass. This
// one computes a :root declaration from :root alone.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(body) {
  const out = new Map();
  for (const d of body.split(';')) {
    const i = d.indexOf(':');
    if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
  }
  return out;
}
function rules(file) {
  const css = strip(fs.readFileSync(path.join(ROOT, file), 'utf-8'))
    .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const map = new Map();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      map.set(selector, new Map([...(map.get(selector) || []), ...declarations(m[2])]));
    }
  }
  return map;
}
const TOKENS = rules('public/styles/tokens.css');
const SCREEN = rules('public/styles/views/run-detail.css');
const ON_ROOT = TOKENS.get(':root');
const ON_LIGHT = TOKENS.get('body.light');

function hex(v) {
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * A custom property's value on <body> in `theme`. In light, a property
 * body.light declares is computed there, from light values; any other is
 * inherited from :root, computed there from :root's own values.
 */
function token(name, theme, where) {
  if (theme === 'light' && ON_LIGHT.has(name)) return resolve(ON_LIGHT.get(name), 'light', `${where} -> ${name} on body.light`);
  assert.ok(ON_ROOT.has(name), `${where}: ${name} is declared nowhere`);
  return resolve(ON_ROOT.get(name), 'dark', `${where} -> ${name} on :root`);
}
function resolve(value, theme, where) {
  const v = value.trim();
  const rgb = hex(v);
  if (rgb) return rgb;
  let m = /^var\((--[\w-]+)\)$/.exec(v);
  if (m) return token(m[1], theme, where);
  m = /^color-mix\(in srgb, (var\(--[\w-]+\)) (\d+)%, (var\(--[\w-]+\))\)$/.exec(v);
  if (m) return mix(resolve(m[1], theme, where), resolve(m[3], theme, where), Number(m[2]) / 100);
  assert.fail(`${where}: cannot resolve ${v}`);
}
// A mix is measured as it is drawn: each channel to a whole 8-bit value.
const mix = (a, b, p) => a.map((c, i) => Math.round(c * p + b[i] * (1 - p)));
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const twoPlaces = (x) => Math.round(x * 100) / 100;

/** The color a rule declares: a property's whole value, or the color in a shorthand. */
function declared(selector, prop) {
  const r = SCREEN.get(selector);
  assert.ok(r && r.has(prop), `run-detail.css has no ${prop} on ${selector}`);
  const value = r.get(prop);
  const found = /var\(--[\w-]+\)$/.exec(value);
  return prop === 'color' || !found ? value : found[0];
}

// [row, what, selector, property, surface, bar, dark ratio, light ratio]
// The surface is a value, so a tint laid on a surface is measured as one.
const ROWS = [
  ['R1', 'a linked file name', '.rd-file-link', 'color', 'var(--card)', 4.5, 5.05, 5.55],
  ['R2', 'a linked file name\'s focus ring', '.rd-file-link:focus-visible', 'outline', 'var(--card)', 3, 4.43, 3.28],
  ['R3', 'Stop\'s label at rest', '.rd-stop', 'color', 'var(--card)', 4.5, 10.82, 14.90],
  ['R4', 'Stop\'s edge at rest', '.rd-stop', 'border', 'var(--card)', 3, 3.20, 3.91],
  ['R5', 'Stop\'s label on hover and focus', '.rd-stop:not(:disabled):hover', 'color',
    'color-mix(in srgb, var(--danger) 5%, var(--elevated))', 4.5, 5.02, 4.63],
  ['R6', 'the shell note', '.rd-note', 'color', 'var(--elevated)', 4.5, 5.55, 5.86],
  ['R7', 'why some names are plain', '.rd-cannot-open', 'color', 'var(--elevated)', 4.5, 5.55, 5.86],
];

describe('the measuring instrument', () => {
  test('it fails a pairing known to fail, and reads a :root mix with :root values', () => {
    // --text-2 on the light card is a known shortfall (3.58:1).
    assert.ok(ratio(token('--text-2', 'light', 'probe'), token('--card', 'light', 'probe')) < 4.5);
    // A mix declared on :root alone, read in light, takes the dark values.
    ON_ROOT.set('--probe', 'color-mix(in srgb, var(--accent-text) 85%, var(--text-1))');
    try {
      assert.deepStrictEqual(token('--probe', 'light', 'probe'), token('--probe', 'dark', 'probe'));
    } finally {
      ON_ROOT.delete('--probe');
    }
  });
});

describe('the link color is computed in each theme from that theme\'s own tokens', () => {
  for (const theme of ['dark', 'light']) {
    test(`in ${theme}, --link-text is 85% of ${theme} --accent-text over ${theme} --text-1`, () => {
      const own = mix(token('--accent-text', theme, theme), token('--text-1', theme, theme), 0.85);
      assert.deepStrictEqual(token('--link-text', theme, theme), own);
    });
  }
});

describe('every color on the run screen passes its bar in both themes', () => {
  for (const [row, what, selector, prop, surface, bar, ...expected] of ROWS) {
    for (const [i, theme] of ['dark', 'light'].entries()) {
      test(`${row}, ${what}, in ${theme}: at least ${bar}:1`, () => {
        const where = `${row} ${theme}`;
        const measured = ratio(resolve(declared(selector, prop), theme, where), resolve(surface, theme, where));
        assert.ok(measured >= bar, `${what} measures ${twoPlaces(measured)}:1 in ${theme}, under ${bar}:1`);
        assert.strictEqual(twoPlaces(measured), expected[i], `${what} in ${theme} no longer measures what the design measured`);
      });
    }
  }
});
