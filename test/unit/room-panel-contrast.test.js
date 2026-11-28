'use strict';
// The colors of the helpers panel and the note under the composer, measured
// in the dark theme and the light theme from the token values in tokens.css,
// in the form of turn-used-contrast.test.js.
//
// Each row names a rule in room-panel.css, the property carrying the color and
// the token it must read, and the surface it sits on: the panel's own
// background, --surface, or the composer's area, --elevated. 4.5:1 for text,
// 3:1 for an icon or an edge. Nothing is a number typed beside a token.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { THEMES, rules, rgb, ratio } = require('../helpers/contrast.js');

// A missing stylesheet reads as no rules, so each row fails on its assertion.
const PANEL_CSS = 'public/styles/components/room-panel.css';
const SHEET = fs.existsSync(path.join(__dirname, '..', '..', PANEL_CSS)) ? rules(PANEL_CSS) : new Map();
const TOKENS = rules('public/styles/tokens.css');

// The one token a declaration reads, by name.
function tokenOf(selector, property) {
  const rule = SHEET.get(selector);
  assert.ok(rule && rule.has(property), `room-panel.css declares no ${property} on ${selector}`);
  const found = rule.get(property).match(/var\(--[\w-]+\)/g) || [];
  assert.strictEqual(found.length, 1, `${selector} ${property} carries one color, not "${rule.get(property)}"`);
  return found[0].slice(4, -1);
}

// A token's color in a theme; --link-text is the 85% mix tokens.css declares
// for both themes at once.
function color(token, theme) {
  if (token !== '--link-text') return rgb(`var(${token})`, THEMES[theme], token);
  const recipe = TOKENS.get(':root').get('--link-text');
  const m = /^color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, var\((--[\w-]+)\)\)$/.exec(recipe);
  assert.ok(m, `--link-text is a color-mix of two tokens, not ${recipe}`);
  const a = color(m[1], theme);
  const b = color(m[3], theme);
  const p = Number(m[2]) / 100;
  return a.map((c, i) => c * p + b[i] * (1 - p));
}

// [what, selector, property, token, surface, bar]
const PAIRS = [
  ['the title', '.room-title', 'color', '--text-1', '--surface', 4.5],
  ['a row\'s name', '.room-who', 'color', '--text-1', '--surface', 4.5],
  ['a row\'s task', '.room-task', 'color', '--text-1', '--surface', 4.5],
  ['the rate line', '.room-rate', 'color', '--text-2-strong', '--surface', 4.5],
  ['the Codex notice', '.room-notice', 'color', '--text-2-strong', '--surface', 4.5],
  ['a row\'s state and the capped text', '.room-state', 'color', '--text-2-strong', '--surface', 4.5],
  ['a Codex row\'s role', '.room-role', 'color', '--text-2-strong', '--surface', 4.5],
  ['the Stop label', '.room-stop', 'color', '--text-2-strong', '--surface', 4.5],
  ['the Stop all label', '.room-stop-all', 'color', '--text-2-strong', '--surface', 4.5],
  ['the bolt', '.room-bolt', 'color', '--text-2-strong', '--surface', 3],
  ['the working dot', '.room-row[data-state="running"] .room-state::before', 'background', '--working-text', '--surface', 3],
  ['the Stop outline', '.room-stop', 'border', '--border-strong', '--surface', 3],
  ['the Stop all outline', '.room-stop-all', 'border', '--border-strong', '--surface', 3],
  ['the file link', '.room-file', 'color', '--link-text', '--surface', 4.5],
  ['the focus ring', '.room-stop:focus-visible', 'outline', '--accent-control', '--surface', 3],
  ['the note under the composer', '.helpers-note', 'color', '--text-2-strong', '--elevated', 4.5],
  ['the note\'s working dot', '.helpers-note::before', 'background', '--working-text', '--elevated', 3],
];

describe('the panel is drawn on --surface', () => {
  test('.room-panel takes --surface for its background', () => {
    assert.strictEqual(tokenOf('.room-panel', 'background'), '--surface');
  });
  test('the focus ring is on every control of the panel', () => {
    for (const selector of ['.room-stop:focus-visible', '.room-stop-all:focus-visible', '.room-file:focus-visible']) {
      assert.strictEqual(tokenOf(selector, 'outline'), '--accent-control', selector);
    }
  });
});

describe('each color of the panel clears its bar on its surface, dark and light', () => {
  for (const [what, selector, property, token, surface, bar] of PAIRS) {
    for (const theme of ['dark', 'light']) {
      test(`${what} (${token} on ${surface}), ${theme}`, () => {
        assert.strictEqual(tokenOf(selector, property), token, `${selector} ${property} reads ${token}`);
        const r = ratio(color(token, theme), color(surface, theme));
        assert.ok(r >= bar, `${what} in ${theme} measures ${r.toFixed(2)}:1, needs ${bar}`);
      });
    }
  }
});
