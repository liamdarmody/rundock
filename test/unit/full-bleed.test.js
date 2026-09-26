'use strict';
// An extension view is full bleed: the pane it holds has no padding, the
// frame and its document paint the pane's own colour, and the document
// carries the note's padding, so the view's content starts where a note's
// text does. Each of those is one declaration a later edit could undo
// without anything else failing, so each is read from the stylesheets here.
// The real-engine proof (edges, pixels, first-line x) is
// test/e2e/full-bleed.spec.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const STYLES = path.join(__dirname, '..', '..', 'public', 'styles');
const read = (rel) => fs.readFileSync(path.join(STYLES, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function rule(rel, selector) {
  const css = read(rel);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `${rel} has no rule for ${selector}`);
  return new Map(m[1].split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
}

test('the pane an extension holds has no padding, and its frame fills it', () => {
  assert.strictEqual(rule('views/editor.css', '.editor-content.extension-pane').get('padding'), '0');
  assert.strictEqual(rule('views/editor.css', '.editor-content.extension-pane > .extension-frame').get('flex'), '1 0 auto');
});

test('the frame and its document paint the pane\'s own colour, with no radius', () => {
  const frame = rule('components/extension-frame.css', '.extension-frame');
  assert.strictEqual(frame.get('background'), 'var(--elevated)');
  assert.strictEqual(frame.get('border-radius'), '0');
  assert.strictEqual(rule('extension-base.css', 'html, body').get('background'), 'var(--elevated)');
  // What the pane itself paints: the editor surface is --elevated in both
  // themes. Read from the rule that paints it, so a change there fails here.
  assert.match(read('views/editor.css') + read('base.css'), /\.main\s*\{[^}]*background:\s*var\(--elevated\)/);
});

test('the frame document carries exactly the note\'s padding, so content lines up with note text', () => {
  const note = rule('views/editor.css', '.editor-content').get('padding');
  assert.strictEqual(note, '24px 32px');
  assert.strictEqual(rule('extension-base.css', 'body').get('padding'), note);
});

test('an embedded view paints its panel\'s surface with no padding, and a view can opt out to full bleed', () => {
  assert.strictEqual(rule('components/embed.css', '.embed-body > .extension-frame').get('background'), 'var(--surface)');
  assert.strictEqual(rule('components/embed.css', '.embed-panel').get('background'), 'var(--surface)');
  assert.strictEqual(rule('extension-base.css', 'body.rundock-embedded').get('padding'), '0');
  assert.strictEqual(rule('extension-base.css', 'body.rundock-full-bleed').get('padding'), '0');
});
