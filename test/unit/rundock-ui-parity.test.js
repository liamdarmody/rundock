'use strict';
// One source: where a Rundock UI component copies a rule the app already
// has, the copy is held to the original, declaration by declaration.
//
// Rundock UI is built from the app's own styles, not beside them. A
// component that reproduces the settings button or the mode toggle has to
// keep reproducing it when the app's rule changes, or an extension's button
// quietly stops looking like Rundock's. Each row below names the app rule,
// the component rule, and the declarations the two must share; the values
// are read from both files on every run.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const STYLES = path.join(__dirname, '..', '..', 'public', 'styles');

function rulesOf(file) {
  const css = fs.readFileSync(path.join(STYLES, file), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
  const map = new Map();
  for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const decls = new Map();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim().replace(/\s+/g, ' '));
    }
    for (const selector of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      map.set(selector, new Map([...(map.get(selector) || []), ...decls]));
    }
  }
  return map;
}

const UI = rulesOf('rundock-ui.css');

// Longhand the border shorthand so `border: 1px solid X` and
// `border-color: X` over a 1px transparent border compare as one fact.
function value(rules, selector, property, file) {
  const rule = rules.get(selector);
  assert.ok(rule, `${file} has no rule for ${selector}`);
  if (rule.has(property)) return rule.get(property);
  if (property === 'border-color' && rule.has('border')) return rule.get('border').split(' ').slice(2).join(' ');
  if (property === 'background' && rule.has('background-color')) return rule.get('background-color');
  assert.fail(`${file} ${selector} declares no ${property}`);
}

// [app file, app selector, component selector, shared declarations]
const PARITY = [
  ['views/settings.css', '.settings-btn', '.rui-btn', ['padding', 'font-size', 'font-weight', 'border-radius']],
  ['views/settings.css', '.settings-btn', '.rui-btn-secondary', ['background', 'color', 'border-color']],
  ['views/settings.css', '.settings-btn:hover', '.rui-btn-secondary:hover:not(:disabled)', ['border-color', 'color']],
  ['views/settings.css', '.settings-btn-primary', '.rui-btn-primary', ['background', 'color']],
  ['views/settings.css', '.settings-btn-primary:hover', '.rui-btn-primary:hover:not(:disabled)', ['background']],
  ['views/settings.css', '.settings-btn.danger', '.rui-btn-danger', ['background', 'color', 'border']],
  ['views/settings.css', '.settings-btn-danger-confirm', '.rui-btn-danger-confirm', ['background', 'color', 'border']],
  ['views/settings.css', '.settings-input', '.rui-input', ['background', 'border', 'border-radius', 'padding', 'font-size', 'color']],
  ['views/settings.css', '.settings-input::placeholder', '.rui-input::placeholder', ['color']],
  ['views/settings.css', '.settings-input:focus-visible', '.rui-input:focus-visible', ['outline', 'outline-offset']],
  ['views/settings.css', '.mode-toggle', '.rui-tabs', ['background', 'border', 'border-radius', 'padding']],
  ['views/settings.css', '.mode-toggle-btn', '.rui-tab', ['padding', 'font-size', 'font-weight', 'border-radius', 'border', 'background', 'color']],
  ['views/settings.css', '.mode-toggle-btn:hover:not(.active)', '.rui-tab:hover:not(.rui-selected)', ['color', 'background']],
  ['views/settings.css', '.mode-toggle-btn.active', '.rui-tab.rui-selected', ['background', 'color', 'border-color', 'box-shadow']],
  ['base.css', '.empty-title', '.rui-empty-title', ['font-size', 'font-weight', 'color']],
  ['base.css', '.empty-subtitle', '.rui-empty-subtitle', ['font-size', 'font-weight', 'color']],
  ['components/region.css', '.region-skeleton', '.rui-canvas-skeleton', ['min-height', 'border-radius', 'background']],
  ['components/region.css', '.region-failed', '.rui-canvas-failed', ['border', 'border-radius', 'padding', 'background', 'min-height', 'gap']],
  ['components/region.css', '.region-failed-reason', '.rui-canvas-failed-reason', ['margin', 'color', 'font-size', 'line-height']],
  ['components/sidebar.css', '.files-menu', '.rui-menu-list', ['border', 'border-radius', 'box-shadow', 'padding']],
  ['views/routines.css', '.icon-btn', '.rui-icon-btn', ['width', 'height', 'border-radius', 'color', 'background', 'border', 'cursor']],
  ['views/routines.css', '.icon-btn:hover', '.rui-icon-btn:hover:not(:disabled)', ['color', 'background', 'border-color']],
  ['views/routines.css', '.icon-btn:disabled', '.rui-icon-btn:disabled', ['opacity', 'cursor']],
  ['views/chat.css', '.send-btn', '.rui-icon-btn-send', ['width', 'height', 'background', 'color', 'border-radius', 'transition', 'flex-shrink']],
  ['views/chat.css', '.send-btn.active', '.rui-icon-btn-send.rui-active', ['background', 'color', 'box-shadow']],
  ['views/chat.css', '.send-btn.active:hover', '.rui-icon-btn-send.rui-active:hover:not(:disabled)', ['background', 'transform', 'box-shadow']],
  ['views/chat.css', '.send-btn:disabled', '.rui-icon-btn-send:disabled', ['opacity', 'cursor']],
  ['views/chat.css', '.send-btn.cancel', '.rui-icon-btn-send.rui-cancel', ['background', 'color', 'cursor', 'opacity']],
  ['views/chat.css', '.send-btn.cancel:hover', '.rui-icon-btn-send.rui-cancel:hover:not(:disabled)', ['background']],
  ['views/chat.css', '.send-btn svg', '.rui-icon-btn-send > svg', ['width', 'height']],
];

describe('Rundock UI copies the app, and the copies hold', () => {
  const files = new Map();
  for (const [file, appSelector, uiSelector, properties] of PARITY) {
    test(`${uiSelector} matches ${file} ${appSelector}`, () => {
      if (!files.has(file)) files.set(file, rulesOf(file));
      const app = files.get(file);
      for (const property of properties) {
        assert.strictEqual(value(UI, uiSelector, property, 'rundock-ui.css'), value(app, appSelector, property, file),
          `${property} of ${uiSelector} has drifted from ${appSelector} in ${file}`);
      }
    });
  }

  test('the waiting pulse is the region pass\'s rhythm', () => {
    const region = fs.readFileSync(path.join(STYLES, 'components', 'region.css'), 'utf-8');
    const ui = fs.readFileSync(path.join(STYLES, 'rundock-ui.css'), 'utf-8');
    const frames = (text, name) => (new RegExp(`@keyframes ${name} \\{([^}]*\\}[^}]*\\})`).exec(text) || [])[1];
    assert.strictEqual(frames(ui, 'rui-waiting'), frames(region, 'region-waiting'));
    assert.match(ui, /animation: rui-waiting 2s ease-in-out infinite/);
    assert.match(region, /animation: region-waiting 2s ease-in-out infinite/);
  });

  test('every animation stops under reduced motion', () => {
    const ui = fs.readFileSync(path.join(STYLES, 'rundock-ui.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    const animated = [...ui.matchAll(/([^{}]+)\{[^{}]*animation:\s*rui-[\w-]+/g)].map((m) => m[1].trim());
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([^}]*)\{ animation: none; \}/.exec(ui);
    assert.ok(reduced, 'rundock-ui.css has no reduced-motion block');
    const stopped = reduced[1].split(',').map((s) => s.trim());
    for (const selector of animated) assert.ok(stopped.includes(selector), `${selector} animates and is not stopped under reduced motion`);
  });
});

// An alert with an action lays its message and action on one first baseline,
// and the icon joins it, so one line reads centred on its buttons and a block
// of text keeps its action beside its first line. Measured in real frames by
// the gallery e2e; held here as the declarations that do it, so the mutation
// harness can remove each and see a test fail.
describe('an alert with an action shares its first line with its buttons', () => {
  test('message and action align on the first baseline; the icon joins it; an alert without one is untouched', () => {
    assert.strictEqual(value(UI, '.rui-alert:has(> .rui-alert-action)', 'align-items'), 'baseline');
    assert.strictEqual(value(UI, '.rui-alert:has(> .rui-alert-action) > svg', 'align-self'), 'baseline');
    assert.strictEqual(value(UI, '.rui-alert:has(> .rui-alert-action) > svg', 'top'), 'calc(8px - 0.36em)');
    assert.strictEqual(value(UI, '.rui-alert', 'align-items'), 'flex-start');
  });
});

describe('every literal in the component stylesheet is a token or allowlisted with its reason', () => {
  test('the drift lint passes on the tree, and it reads rundock-ui.css', () => {
    // Run as its own process, the way the gate runs it, so this suite holds
    // no second copy of the lint's rules.
    const { execFileSync } = require('node:child_process');
    const root = path.join(__dirname, '..', '..');
    let out = '';
    try {
      out = execFileSync('node', ['test/tools/style-drift.js'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      assert.fail(`the drift lint refused the tree:\n${e.stdout || ''}${e.stderr || ''}`);
    }
    assert.match(out, /style-drift: clean/);
    const report = execFileSync('node', ['test/tools/style-drift.js', '--report'], { cwd: root, encoding: 'utf8' });
    assert.match(report, /public\/styles\/rundock-ui\.css {2}\(\d+\)/, 'the lint reads the component stylesheet; a blind read would pass vacuously');
  });
});
