'use strict';
// The attention hue is two tokens, following --accent / --accent-text.
//
// --attention is the hue for edges and tints: borders, glows, the color-mix()
// a notice's border is made from. --attention-text is the hue as TEXT and as
// an icon, theme-aware because --attention as text on the light surfaces
// measures about 2:1. Every ratio below is computed from tokens.css on every
// run, so an edit to the value, or to a surface it lands on, fails here.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const TOKENS = path.join(ROOT, 'public', 'styles', 'tokens.css');
const WORKSPACE_CSS = path.join(ROOT, 'public', 'styles', 'views', 'workspace.css');

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

function tokenBlocks() {
  const clean = stripComments(fs.readFileSync(TOKENS, 'utf-8'));
  const start = clean.indexOf('body.light {');
  assert.ok(start !== -1, 'the light theme block should exist');
  const end = clean.indexOf('}', start);
  const declare = (text) => new Map(
    [...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]),
  );
  const dark = declare(clean.slice(0, start) + clean.slice(end));
  assert.ok(dark.size > 30, 'the attention token parse found almost nothing, so this proves nothing');
  // Light inherits whatever it does not override.
  const light = new Map([...dark, ...declare(clean.slice(start, end))]);
  return { dark, light };
}

function hex(value, name) {
  const m = /^#([0-9a-f]{6})$/i.exec(value || '');
  assert.ok(m, `${name} is ${value}, not a six-digit hex; this test reads only that shape`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(value, name) {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value || '');
  assert.ok(m, `${name} is ${value}, not rgba(); this test reads only that shape`);
  return { rgb: [+m[1], +m[2], +m[3]], a: +m[4] };
}
// A translucent tint laid over an opaque surface, as the browser composites it.
const over = (tint, bg) => bg.map((c, i) => tint.rgb[i] * tint.a + c * (1 - tint.a));
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const twoPlaces = (x) => Math.round(x * 100) / 100;

describe('--attention-text reads as text', () => {
  test('dark: the hue itself, 4.5:1 or better on every surface', () => {
    const { dark } = tokenBlocks();
    const fg = hex(dark.get('--attention-text'), '--attention-text');
    assert.deepStrictEqual(fg, hex(dark.get('--attention'), '--attention'), 'dark text is the hue itself');
    for (const s of ['--base', '--surface', '--elevated', '--card']) {
      const r = contrast(fg, hex(dark.get(s), s));
      assert.ok(r >= 4.5, `dark ${s} measures ${r.toFixed(2)}`);
    }
    assert.strictEqual(twoPlaces(contrast(fg, hex(dark.get('--base'), '--base'))), 8.4);
  });

  test('light: darker than the hue, 4.5:1 or better on every surface', () => {
    const { light } = tokenBlocks();
    const fg = hex(light.get('--attention-text'), '--attention-text');
    for (const s of ['--base', '--surface', '--elevated', '--card']) {
      const r = contrast(fg, hex(light.get(s), s));
      assert.ok(r >= 4.5, `light ${s} measures ${r.toFixed(2)}`);
    }
    assert.strictEqual(twoPlaces(contrast(fg, hex(light.get('--base'), '--base'))), 4.78);
    const asText = contrast(hex(light.get('--attention'), '--attention'), hex(light.get('--base'), '--base'));
    assert.ok(asText < 3, `the reason for the token: --attention as text on light measures ${asText.toFixed(2)}`);
  });

  test('the notice icon clears 3:1 on its tinted background in both themes', () => {
    for (const [theme, block] of Object.entries(tokenBlocks())) {
      const bg = over(rgba(block.get('--attention-glow'), '--attention-glow'), hex(block.get('--base'), '--base'));
      const r = contrast(hex(block.get('--attention-text'), '--attention-text'), bg);
      assert.ok(r >= 3, `${theme} icon measures ${r.toFixed(2)}`);
    }
  });
});

describe('the new-workspace form uses the text token for text', () => {
  const css = stripComments(fs.readFileSync(WORKSPACE_CSS, 'utf-8'));
  const rule = (sel) => {
    const m = new RegExp(`(?:^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    assert.ok(m, `${sel} is in workspace.css`);
    return m[1];
  };
  test('the removed-characters hint and the notice icon colour with --attention-text', () => {
    assert.match(rule('.ws-picker-hint.is-notice'), /(?:^|;)\s*color:\s*var\(--attention-text\)/);
    assert.match(rule('.ws-name-notice-icon'), /(?:^|;)\s*color:\s*var\(--attention-text\)/);
  });
  test('the edges stay on the hue', () => {
    assert.match(rule('.ws-picker-input.is-notice'), /border-color:\s*var\(--attention\)/);
    assert.match(rule('.ws-name-notice'), /var\(--attention\) 40%/);
  });
});
