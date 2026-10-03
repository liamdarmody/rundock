'use strict';
// look-view's options: what is accepted, what each default is, and that every
// mistake comes back as one plain sentence naming the option. The capture
// itself needs a browser and is covered by test/e2e/look-view.spec.js.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(path.sep, 'checkout');
let mod;
before(async () => { mod = await import('../../scripts/screenshots/look-view-options.mjs'); });

const norm = (raw) => mod.normalizeOptions(raw, { root: ROOT });
const rejects = (raw, pattern) => assert.throws(() => norm(raw), (err) => {
  assert.match(err.message, pattern);
  assert.equal(err.lookView, true, 'a look-view error, not an unexpected crash');
  return true;
});

describe('look-view options', () => {
  test('no options file means the team chart, dark, 1440 by 900, written to the scratch folder', () => {
    const o = mod.parseOptionsText(null, { root: ROOT });
    assert.equal(o.view, 'team');
    assert.equal(o.theme, 'dark');
    assert.equal(o.width, 1440);
    assert.equal(o.height, 900);
    assert.equal(o.scale, 1);
    assert.equal(o.out, path.join(ROOT, '.rundock', 'scratch', 'look-view.png'));
    assert.deepEqual(o.actions, []);
  });

  test('a relative out resolves against the checkout, an absolute one is kept', () => {
    assert.equal(norm({ out: 'shots/a.png' }).out, path.join(ROOT, 'shots', 'a.png'));
    const abs = path.join(path.sep, 'elsewhere', 'b.png');
    assert.equal(norm({ out: abs }).out, abs);
  });

  test('each view takes its own defaults', () => {
    assert.equal(norm({ view: 'files' }).file, 'Welcome.md');
    assert.equal(norm({ view: 'files', file: 'Backlog.md' }).file, 'Backlog.md');
    assert.equal(norm({ view: 'settings' }).section, 'workspace');
    assert.equal(norm({ view: 'settings', section: 'appearance' }).section, 'appearance');
    assert.equal(norm({ view: 'conversations' }).conversation, null);
    assert.equal(norm({ view: 'conversations', conversation: 'Plan the week' }).conversation, 'Plan the week');
    assert.equal(norm({ view: 'team' }).file, null);
  });

  test('an unknown view names the views there are', () => {
    rejects({ view: 'dashboard' }, /^View not found: "dashboard"\. Views: team, conversations, files, routines, settings/);
  });

  test('an option for another view is refused rather than ignored', () => {
    rejects({ view: 'team', file: 'Welcome.md' }, /"file" only applies to the files view, but the view is team/);
    rejects({ section: 'appearance' }, /"section" only applies to the settings view/);
  });

  test('theme, sizes and output are checked', () => {
    rejects({ theme: 'blue' }, /"theme" must be "dark" or "light"/);
    rejects({ width: 100 }, /"width" must be a whole number from 320 to 3840, got 100/);
    rejects({ height: '900' }, /"height" must be a whole number/);
    rejects({ scale: 1.5 }, /"scale" must be a whole number from 1 to 3/);
    rejects({ out: 'shot.jpg' }, /"out" must end in \.png/);
    rejects({ out: '' }, /"out" must be a non-empty string/);
  });

  test('an unknown option is named, so a typo does not silently take a default', () => {
    rejects({ veiw: 'files' }, /Unknown option "veiw"/);
  });

  test('actions: click by role and name, by selector string, by text; fill; press; wait for text', () => {
    const o = norm({ actions: [
      { click: { role: 'button', name: 'Save' } },
      { click: '#tb-search' },
      { click: { text: 'Plan the week' } },
      { fill: { label: 'Name' }, value: 'Ada' },
      { press: 'Escape' },
      { waitForText: 'Saved' },
    ] });
    assert.deepEqual(o.actions, [
      { type: 'click', target: { role: 'button', name: 'Save' } },
      { type: 'click', target: { selector: '#tb-search' } },
      { type: 'click', target: { text: 'Plan the week' } },
      { type: 'fill', target: { label: 'Name' }, value: 'Ada' },
      { type: 'press', key: 'Escape' },
      { type: 'waitForText', text: 'Saved' },
    ]);
  });

  test('a malformed action is named by its position', () => {
    rejects({ actions: {} }, /"actions" must be a list/);
    rejects({ actions: [{ hover: '#x' }] }, /actions\[0\] must be one of click, fill, press or waitForText/);
    rejects({ actions: [{ press: 'Escape' }, { click: { role: 'button', selector: '#x' } }] }, /actions\[1\]\.click must name an element with exactly one of selector, role, text, label, got selector and role/);
    rejects({ actions: [{ click: { text: 'Go', name: 'x' } }] }, /actions\[0\]\.click\.name only goes with "role"/);
    rejects({ actions: [{ fill: '#x' }] }, /actions\[0\] fills an element, so it needs a string "value"/);
  });

  test('the options file must be a JSON object', () => {
    assert.throws(() => mod.parseOptionsText('{ view: team }', { root: ROOT }), /\.rundock\/look-view\.json is not valid JSON/);
    assert.throws(() => mod.parseOptionsText('[]', { root: ROOT }), /The options must be a JSON object/);
  });

  test('targets read plainly in a message', () => {
    assert.equal(mod.describeTarget({ role: 'button', name: 'Save' }), 'role button named "Save"');
    assert.equal(mod.describeTarget({ selector: '#x' }), 'selector "#x"');
    assert.equal(mod.describeTarget({ text: 'Hi' }), 'text "Hi"');
    assert.equal(mod.describeTarget({ label: 'Name' }), 'label "Name"');
  });
});
