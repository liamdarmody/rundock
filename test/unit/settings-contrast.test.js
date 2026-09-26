'use strict';
// Every text pairing the Permissions and Extensions panes draw, measured in
// both themes from the real tokens and the real settings stylesheet.
//
// Nothing here is a number typed beside a token. Each row names a rule in
// public/styles/views/settings.css and the property carrying the foreground,
// resolves it through tokens.css for the theme (following var() and the
// color-mix() steps the pane defines), and computes the WCAG 2 ratio against
// the surface the element sits on. Small text is held to 4.5:1 and a control's
// edge to 3:1.
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
const SETTINGS = rules('public/styles/views/settings.css');
const THEMES = {
  dark: new Map([...TOKENS.get(':root'), ...SETTINGS.get('.settings-content')]),
  light: new Map([...TOKENS.get(':root'), ...TOKENS.get('body.light'), ...SETTINGS.get('.settings-content')]),
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
    assert.ok(THEMES[theme].has(m[1]), `${where}: ${m[1]} is declared nowhere for ${theme}`);
    return resolve(THEMES[theme].get(m[1]), theme, `${where} -> ${m[1]}`);
  }
  m = /^color-mix\(in srgb, (var\(--[\w-]+\)) (\d+)%, (var\(--[\w-]+\))\)$/.exec(v);
  if (m) {
    const a = resolve(m[1], theme, where);
    const b = resolve(m[3], theme, where);
    const p = Number(m[2]) / 100;
    return a.map((c, i) => c * p + b[i] * (1 - p));
  }
  if (v === 'white') return [255, 255, 255];
  assert.fail(`${where}: cannot resolve ${v}`);
}
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
// The foreground a rule declares, read from the stylesheet.
function fg(selector, prop = 'color') {
  const r = SETTINGS.get(selector);
  assert.ok(r && r.has(prop), `settings.css has no ${prop} on ${selector}`);
  return r.get(prop);
}
function measure(foreground, surface, theme, where) {
  return ratio(resolve(foreground, theme, where), resolve(`var(${surface})`, theme, where));
}

// [what, selector, property, surface it sits on, bar]
const PERMISSIONS = [
  ['section title', '.settings-section-title', 'color', '--elevated', 4.5],
  ['lead', '.settings-lead', 'color', '--elevated', 4.5],
  ['mode description', '.mode-description', 'color', '--card', 4.5],
  // The inactive mode tab is left at --text-2: Rundock UI's tabs copy this rule
  // declaration for declaration (test/unit/rundock-ui-parity.test.js), and its
  // light-theme ratio is a known shortfall pinned in rundock-ui-contrast.test.js.
  ['caption on a card', '.settings-caption', 'color', '--card', 4.5],
  ['caption on the pane', '.settings-caption', 'color', '--elevated', 4.5],
  ['who controls it', '.ownership-note', 'color', '--card', 4.5],
  ['On and Off', '.onoff-label', 'color', '--card', 4.5],
  ['Unavailable label', '.settings-label.is-quiet', 'color', '--card', 4.5],
  ['the lock', '.readonly-lock', 'color', '--card', 3],
  ['confirmation', '.wall-confirm p', 'color', '--elevated', 4.5],
  ['review folders', '.wall-review-list', 'color', '--elevated', 4.5],
  ['review warning', '.wall-review .wall-review-warn', 'color', '--elevated', 4.5],
  ['a failed write', '.sandbox-error', 'color', '--card', 4.5],
  ['the notice', '.migration-notice', 'color', '--card', 4.5],
  ['the switch edge at rest', '.toggle-hit .rui-toggle', 'border-color', '--card', 3],
  ['folders heading', '.wf-section-head', 'color', '--card', 4.5],
  ['folders explanation', '.wf-section-sub', 'color', '--card', 4.5],
  ['a folder path', '.wf-path', 'color', '--card', 4.5],
  ['a missing folder', '.wf-missing', 'color', '--card', 4.5],
  ['the covered-by hint', '.wf-hint', 'color', '--card', 4.5],
  ['the undo strip', '.wf-undo', 'color', '--elevated', 4.5],
  ['the undo link', '.wf-undo-btn', 'color', '--elevated', 4.5],
  ['a folder\'s remove control', '.wf-remove', 'color', '--card', 3],
];

const EXTENSIONS = [
  ['section title', '.settings-section-title', 'color', '--elevated', 4.5],
  ['lead', '.settings-lead', 'color', '--elevated', 4.5],
  ['a name', '.ext-page-name', 'color', '--card', 4.5],
  ['a version', '.ext-page-ver', 'color', '--card', 4.5],
  ['when it was added', '.ext-page-added', 'color', '--card', 4.5],
  ['where it came from', '.ext-page-from', 'color', '--card', 4.5],
  ['the package link', '.ext-page-row .linkbtn.accent', 'color', '--card', 4.5],
  ['a row\'s notes', '.ext-page-line', 'color', '--card', 4.5],
  ['could not load', '.ext-page-line.is-danger', 'color', '--card', 4.5],
  ['the chip', '.ext-page-chip', 'color', '--danger', 4.5],
  ['On and Off', '.onoff-label', 'color', '--card', 4.5],
  ['the paused banner', '.ext-paused-banner p', 'color', '--card', 4.5],
  ['the pause caption', '.ext-pause p', 'color', '--card', 4.5],
  ['the empty state', '.ext-page-empty', 'color', '--card', 4.5],
  ['Go to Packages', '.ext-page-empty .linkbtn.accent', 'color', '--card', 4.5],
  ['the switch edge at rest', '.toggle-hit .rui-toggle', 'border-color', '--card', 3],
  // The install card's host claims, the view state line among them.
  ['the install card\'s claims', '.extension-host-claims', 'color', '--card', 4.5],
];

describe('the measuring instrument', () => {
  test('it fails a pairing that is known to fail, and passes one known to pass', () => {
    assert.ok(measure('var(--text-3)', '--card', 'dark', 'specimen') < 4.5, '--text-3 on a dark card is 2.61:1');
    assert.ok(measure('var(--text-1)', '--card', 'light', 'specimen') >= 4.5);
  });
});

describe('the Permissions pane reads in both themes', () => {
  for (const theme of ['dark', 'light']) {
    for (const [what, selector, prop, surface, bar] of PERMISSIONS) {
      test(`${theme}: ${what} is at least ${bar}:1`, () => {
        const r = measure(fg(selector, prop), surface, theme, `${selector} ${prop}`);
        assert.ok(r >= bar, `${selector} ${prop} on ${surface}: ${r.toFixed(2)}:1`);
      });
    }
  }
});

describe('the Extensions page reads in both themes', () => {
  for (const theme of ['dark', 'light']) {
    for (const [what, selector, prop, surface, bar] of EXTENSIONS) {
      test(`${theme}: ${what} is at least ${bar}:1`, () => {
        const r = measure(fg(selector, prop), surface, theme, `${selector} ${prop}`);
        assert.ok(r >= bar, `${selector} ${prop} on ${surface}: ${r.toFixed(2)}:1`);
      });
    }
  }
});

module.exports = { measure, fg };
