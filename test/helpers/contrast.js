'use strict';
// Contrast measured from the shipped tokens and stylesheets, as
// test/unit/editor-link-contrast.test.js measures it. A row names the rule
// and property carrying a color, the token it must read, and the rule and
// property (and token) of what it sits on. The row reads both declarations
// (a `body.light` variant wins in light, as it does on the page), checks they
// read those tokens, so a stylesheet that sets another token fails it,
// resolves them against tokens.css in each theme and computes the WCAG 2
// ratio. Nothing is a number typed beside a token.
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

// selector -> declarations, outside @media blocks.
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

function declared(sheet, selector, property, themeName) {
  const light = sheet.get(`body.light ${selector}`);
  if (themeName === 'light' && light && light.has(property)) return light.get(property);
  const rule = sheet.get(selector);
  assert.ok(rule && rule.has(property), `no ${property} on ${selector}; if the rule moved, move this row with it`);
  return rule.get(property);
}

// The one color a declaration carries: the value itself, or the var() in a
// shorthand such as `2px solid var(--accent-control)`.
function colorIn(value, where) {
  const found = value.match(/var\(--[\w-]+\)|#[0-9a-f]{6}\b/gi) || [];
  assert.strictEqual(found.length, 1, `${where} carries one color, not "${value}"`);
  return found[0];
}

// The ratio of `fg` on `bg`, each [selector, property, token], in theme
// `name`, once each is found to read its token.
function measure(sheet, fg, bg, name) {
  const theme = THEMES[name];
  const color = ([selector, property, token]) => {
    const value = colorIn(declared(sheet, selector, property, name), `${selector} ${property}`);
    assert.strictEqual(value, `var(${token})`, `${selector} ${property} reads ${token}`);
    return rgb(value, theme, selector);
  };
  return ratio(color(fg), color(bg));
}

// One test per row and theme: the ratio clears the row's bar.
function rowsClear(test, sheet, rows) {
  for (const [label, fg, bg, bar] of rows) {
    for (const name of ['dark', 'light']) {
      test(`${label}, ${name}`, () => {
        const r = measure(sheet, fg, bg, name);
        assert.ok(r >= bar, `${label} in ${name} measures ${r.toFixed(2)}:1, needs ${bar}`);
      });
    }
  }
}

module.exports = { THEMES, rules, rgb, ratio, measure, rowsClear };
