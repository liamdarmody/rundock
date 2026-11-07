'use strict';
// The colours the monthly schedule work adds, measured in the dark theme and
// the light theme from the token values in tokens.css.
//
// Two new things on the routines screens carry text: the unreadable-schedule
// notice on a row, now a red lead and a quiet body, and the line on a run
// record that says the run started late. The lead needs a new token,
// --danger-text-card, because --danger-text measures under 4.5:1 on --card in
// both themes (4.36 dark, 4.29 light). The other three uses take existing
// tokens and are measured here so a later edit to a token or a surface fails
// with the new ratio in the message.
//
// Nothing below is a number typed beside a token: each ratio is resolved from
// the declarations, following var() and color-mix(), and compared at two
// places, which is the precision the values were chosen at.
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

// Every rule in a stylesheet, by selector, with later rules for the same
// selector merged over earlier ones.
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
const DARK = TOKENS.get(':root');
const LIGHT = TOKENS.get('body.light');
const THEMES = {
  dark: DARK,
  light: new Map([...DARK, ...LIGHT]),
};

function hex(v) {
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function resolve(value, theme, where) {
  const v = value.trim();
  const rgb = hex(v);
  if (rgb) return rgb;
  let m = /^var\((--[\w-]+)\)$/.exec(v);
  if (m) {
    assert.ok(THEMES[theme].has(m[1]), `${where}: ${m[1]} is declared nowhere for the ${theme} theme`);
    return resolve(THEMES[theme].get(m[1]), theme, `${where} -> ${m[1]}`);
  }
  m = /^color-mix\(in srgb, (var\(--[\w-]+\)) (\d+)%, (var\(--[\w-]+\))\)$/.exec(v);
  if (m) {
    const a = resolve(m[1], theme, where);
    const b = resolve(m[3], theme, where);
    const p = Number(m[2]) / 100;
    // Rounded to whole channels, as the screen paints the mix.
    return a.map((c, i) => Math.round(c * p + b[i] * (1 - p)));
  }
  assert.fail(`${where}: cannot resolve ${v}`);
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const twoPlaces = (x) => Math.round(x * 100) / 100;

// [use, token, surface, needs, dark, light]
const USES = [
  ['notice lead', '--danger-text-card', '--card', 4.5, 4.97, 5.31],
  ['notice body', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['late line, lead word', '--text-1', '--elevated', 4.5, 12.79, 17.40],
  ['late line, text', '--text-2-strong', '--elevated', 4.5, 5.55, 5.86],
];

describe('the token the unreadable-schedule lead reads', () => {
  test('the stylesheets parse to more than a handful of declarations', () => {
    // A floor under the extraction: a pattern that stopped matching would
    // otherwise leave empty maps, and every lookup below would fail for a
    // reason the message does not name.
    assert.ok(DARK && DARK.size > 40, 'the token parse found almost nothing in :root, so this proves nothing');
    assert.ok(LIGHT && LIGHT.size > 15, 'the token parse found almost nothing in body.light, so this proves nothing');
  });

  test('--danger-text-card is declared for the dark theme and for the light theme', () => {
    // Declared twice on purpose. A custom property built from other custom
    // properties is resolved where it is declared, so one declared only on
    // :root would carry the dark --danger-text into the light theme.
    assert.ok(DARK.has('--danger-text-card'), 'tokens.css declares no --danger-text-card on :root');
    assert.ok(LIGHT.has('--danger-text-card'), 'tokens.css declares no --danger-text-card on body.light');
  });

  test('its value is the recipe Settings already uses for danger text on a card', () => {
    const settings = rules('public/styles/views/settings.css').get('.settings-content');
    const recipe = 'color-mix(in srgb, var(--danger-text) 85%, var(--text-1))';
    assert.strictEqual(settings.get('--settings-danger-text'), recipe, 'settings.css changed its recipe; follow it here');
    assert.strictEqual(DARK.get('--danger-text-card'), recipe);
    assert.strictEqual(LIGHT.get('--danger-text-card'), recipe);
  });
});

describe('each new use clears 4.5:1 on its surface, in both themes', () => {
  for (const [use, token, surface, needs, dark, light] of USES) {
    test(`${use}: ${token} on ${surface}`, () => {
      const measured = {};
      for (const theme of ['dark', 'light']) {
        measured[theme] = ratio(resolve(`var(${token})`, theme, use), resolve(`var(${surface})`, theme, use));
      }
      assert.strictEqual(twoPlaces(measured.dark), dark, `dark measures ${measured.dark.toFixed(4)}`);
      assert.strictEqual(twoPlaces(measured.light), light, `light measures ${measured.light.toFixed(4)}`);
      assert.ok(measured.dark >= needs && measured.light >= needs, `${use} must clear ${needs}:1`);
    });
  }
});

describe('the rules that draw them read those tokens', () => {
  test('the notice lead and body', () => {
    const css = rules('public/styles/views/routines.css');
    assert.ok(css.has('.schedule-problem-lead'), 'routines.css has no rule for the notice lead');
    assert.strictEqual(css.get('.schedule-problem-lead').get('color'), 'var(--danger-text-card)');
    assert.ok(css.has('.schedule-problem-body'), 'routines.css has no rule for the notice body');
    assert.strictEqual(css.get('.schedule-problem-body').get('color'), 'var(--text-2-strong)');
  });

  test('the late line on a run, on its elevated surface', () => {
    const css = rules('public/styles/views/run-detail.css');
    assert.ok(css.has('.rd-late') && css.has('.rd-late b'), 'run-detail.css has no rule for the late line');
    assert.strictEqual(css.get('.rd-late').get('background-color'), 'var(--elevated)');
    assert.strictEqual(css.get('.rd-late').get('color'), 'var(--text-2-strong)');
    assert.strictEqual(css.get('.rd-late b').get('color'), 'var(--text-1)');
  });
});
