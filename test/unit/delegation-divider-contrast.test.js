'use strict';
// The colors the handover divider and the stopped-delegate line read, measured
// in the dark theme and the light theme from the token values in tokens.css.
//
// The divider's names and words used to take the agent's own color, which
// fails 4.5:1 in the light theme for some agents. They now take theme text
// tokens, and the avatars carry the agent color. The line that says a
// delegate stopped sits on a card: a title, a quieter reason, a red icon and,
// on Codex, the runtime's own message in a mono block on the page's base (or,
// in the light theme, on the elevated surface).
//
// Each ratio is resolved from the declarations, following var() and
// color-mix(), never typed beside a token. Each rule is read out of chat.css,
// so a rule that names another token, or an agent's color, fails here.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const source = (file) => strip(fs.readFileSync(path.join(ROOT, file), 'utf-8'));

function declarations(body) {
  const out = new Map();
  for (const d of body.split(';')) {
    const i = d.indexOf(':');
    if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
  }
  return out;
}

const MEDIA = /@media([^{]*)\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g;

// Every rule in a block of CSS, by selector, with later rules for the same
// selector merged over earlier ones.
function rulesIn(css) {
  const map = new Map();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      map.set(selector, new Map([...(map.get(selector) || []), ...declarations(m[2])]));
    }
  }
  return map;
}

// The rules outside any @media block.
const rules = (file) => rulesIn(source(file).replace(MEDIA, ''));

// The rules inside the @media blocks whose condition includes `condition`.
function mediaRules(file, condition) {
  const css = [...source(file).matchAll(MEDIA)]
    .filter((m) => m[1].replace(/\s+/g, ' ').includes(condition))
    .map((m) => m[2]).join('\n');
  return rulesIn(css);
}

const TOKENS = rules('public/styles/tokens.css');
const DARK = TOKENS.get(':root');
const LIGHT = TOKENS.get('body.light');
const THEMES = {
  dark: DARK,
  light: new Map([...(DARK || []), ...(LIGHT || [])]),
};
const CHAT = rules('public/styles/views/chat.css');

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

// The value a chat.css rule declares, refusing when the rule or the property
// is missing so a renamed selector fails by name.
function declared(selector, property) {
  assert.ok(CHAT.has(selector), `chat.css has no rule for ${selector}`);
  assert.ok(CHAT.get(selector).has(property), `chat.css declares no ${property} on ${selector}`);
  return CHAT.get(selector).get(property);
}

// [use, selector, property, token, surface (dark), surface (light), floor]
const USES = [
  ['divider names', '.handover .hv-name', 'color', '--text-1', '--elevated', '--elevated', 4.5],
  ['divider words', '.handover .delegation-badge', 'color', '--text-2-strong', '--elevated', '--elevated', 4.5],
  ['stopped title', '.stopped-title', 'color', '--text-1', '--card', '--card', 4.5],
  ['stopped reason', '.stopped-reason', 'color', '--text-2-strong', '--card', '--card', 4.5],
  ['circle-x icon', '.msg-stopped > svg', 'color', '--danger-text-card', '--card', '--card', 3],
  ['Codex detail', '.stopped-detail', 'color', '--text-1', '--base', '--elevated', 4.5],
];

describe('the tokens the divider and the stopped line read', () => {
  test('the token parse found more than a handful of declarations', () => {
    // A floor under the extraction: a pattern that stopped matching would
    // otherwise leave empty maps, and every lookup below would fail for a
    // reason the message does not name.
    assert.ok(DARK && DARK.size > 40, 'the token parse found almost nothing in :root, so nothing below is measured');
    assert.ok(LIGHT && LIGHT.size > 15, 'the token parse found almost nothing in body.light, so nothing below is measured');
    assert.ok(CHAT.size > 40, 'the chat.css parse found almost no rules, so nothing below is measured');
  });

  test('each rule names its token and no other', () => {
    for (const [use, selector, property, token] of USES) {
      assert.strictEqual(declared(selector, property), `var(${token})`,
        `${use}: ${selector} must take ${token}, never another token or an agent's color`);
    }
  });

  test('the surfaces the line sits on are the ones measured', () => {
    assert.strictEqual(declared('.msg-stopped', 'background'), 'var(--card)', 'the line sits on the card');
    assert.strictEqual(declared('.stopped-detail', 'background'), 'var(--base)', 'the dark detail sits on the base');
    assert.strictEqual(declared('body.light .stopped-detail', 'background'), 'var(--elevated)',
      'the light detail sits on the elevated surface');
  });
});

describe('each use clears its floor on its surface, in both themes', () => {
  for (const [use, selector, , token, darkSurface, lightSurface, floor] of USES) {
    test(`${use}: ${token} on ${darkSurface} (dark) and ${lightSurface} (light)`, () => {
      const surfaces = { dark: darkSurface, light: lightSurface };
      for (const theme of ['dark', 'light']) {
        const where = `${use} (${selector}, ${theme})`;
        const measured = ratio(resolve(`var(${token})`, theme, where), resolve(`var(${surfaces[theme]})`, theme, where));
        assert.ok(measured >= floor, `${where} measures ${measured.toFixed(2)}:1, under ${floor}:1`);
      }
    });
  }
});

describe('the detail shows in full and the line respects reduced motion', () => {
  test('the Codex detail wraps and is never cut', () => {
    assert.strictEqual(declared('.stopped-detail', 'overflow-wrap'), 'anywhere', 'a long word wraps rather than overflowing');
    const rule = CHAT.get('.stopped-detail');
    for (const property of ['text-overflow', '-webkit-line-clamp', 'max-height']) {
      assert.ok(!rule.has(property), `.stopped-detail declares ${property}, which can cut the runtime's message`);
    }
    for (const property of ['overflow', 'overflow-y', 'overflow-x']) {
      assert.notStrictEqual(rule.get(property), 'hidden', `.stopped-detail hides its ${property}, which cuts the message`);
    }
  });

  test('the line does not fade in when the person asked for reduced motion', () => {
    const reduced = mediaRules('public/styles/views/chat.css', 'prefers-reduced-motion: reduce');
    assert.ok(reduced.has('.msg-stopped'), 'chat.css has no reduced-motion rule for .msg-stopped');
    assert.strictEqual(reduced.get('.msg-stopped').get('animation'), 'none');
  });
});
