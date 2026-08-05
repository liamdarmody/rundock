'use strict';
// The editor's right-click menu, as a decision rather than as Electron wiring.
//
// Electron does not give an app Chromium's default context menu: unless the
// main process listens for `context-menu` and builds one, right-clicking does
// nothing at all. Rundock listened for nothing, so the packaged app had no
// spelling suggestions AND no Cut / Copy / Paste / Select All anywhere.
//
// The shape of the menu is pure logic over the `params` Electron hands us, so
// it lives in a module that never requires electron and is tested directly.
// The Electron-facing half of this feature is a dozen lines of wiring; this is
// the half that has edge cases.
//
// The gating case is the one that matters most. The renderer has its own
// custom menus on conversation rows and file-tree rows. A renderer calling
// preventDefault() does NOT stop the main-process event firing, so without a
// gate the app would show two menus at once on those rows.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const buildContextMenuTemplate = require('../../electron/context-menu-template.js');

// A realistic Electron `params` object, overridable per case.
const params = (over = {}) => ({
  isEditable: true,
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
  ...over,
});

const labels = (t) => (t || []).map((i) => i.label || i.role || i.type);
const actions = (t) => (t || []).filter((i) => i.action).map((i) => i.action);

describe('buildContextMenuTemplate', () => {
  describe('gating: only editable targets get a menu', () => {
    test('a non-editable target gets no menu at all, so renderer menus stand alone', () => {
      // A conversation row or file-tree row. The renderer draws its own menu
      // here; returning null is what stops the two racing.
      assert.strictEqual(buildContextMenuTemplate(params({ isEditable: false })), null);
    });

    test('a non-editable target with a selection still gets no menu', () => {
      // Tempting to offer Copy on selected read-only text, but that would put
      // a second menu on top of the renderer's own on those same rows.
      const t = buildContextMenuTemplate(params({
        isEditable: false,
        editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
      }));
      assert.strictEqual(t, null);
    });

    test('an editable target always gets a menu, even with nothing selected', () => {
      const t = buildContextMenuTemplate(params());
      assert.ok(Array.isArray(t) && t.length > 0);
    });
  });

  describe('the standard editing items, which the app never had', () => {
    test('offers cut, copy, paste and select all', () => {
      const l = labels(buildContextMenuTemplate(params()));
      for (const role of ['cut', 'copy', 'paste', 'selectAll']) assert.ok(l.includes(role), `missing ${role}`);
    });

    test('cut and copy are disabled with no selection, paste is not', () => {
      const t = buildContextMenuTemplate(params());
      const by = Object.fromEntries(t.filter((i) => i.role).map((i) => [i.role, i]));
      assert.strictEqual(by.cut.enabled, false);
      assert.strictEqual(by.copy.enabled, false);
      assert.strictEqual(by.paste.enabled, true);
    });

    test('cut and copy enable once there is a selection', () => {
      const t = buildContextMenuTemplate(params({
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      }));
      const by = Object.fromEntries(t.filter((i) => i.role).map((i) => [i.role, i]));
      assert.strictEqual(by.cut.enabled, true);
      assert.strictEqual(by.copy.enabled, true);
    });

    test('enabled state is taken from Electron, not guessed', () => {
      // Paste depends on the clipboard, which this module cannot see.
      const t = buildContextMenuTemplate(params({
        editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
      }));
      const by = Object.fromEntries(t.filter((i) => i.role).map((i) => [i.role, i]));
      assert.strictEqual(by.paste.enabled, false);
      assert.strictEqual(by.selectAll.enabled, false);
    });
  });

  describe('spelling suggestions', () => {
    const misspelled = () => params({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'tech', 'ten'],
    });

    test('every suggestion is offered, in the order the OS gave them', () => {
      const l = labels(buildContextMenuTemplate(misspelled()));
      assert.deepStrictEqual(l.slice(0, 3), ['the', 'tech', 'ten']);
    });

    test('choosing a suggestion replaces the misspelling with that word', () => {
      const a = actions(buildContextMenuTemplate(misspelled()));
      assert.deepStrictEqual(a[0], { type: 'replaceMisspelling', word: 'the' });
      assert.deepStrictEqual(a[1], { type: 'replaceMisspelling', word: 'tech' });
    });

    test('offers adding the word to the dictionary', () => {
      const a = actions(buildContextMenuTemplate(misspelled()));
      assert.ok(a.some((x) => x.type === 'addToDictionary' && x.word === 'teh'));
    });

    test('suggestions come first, above a separator, so the fix is the nearest item', () => {
      const l = labels(buildContextMenuTemplate(misspelled()));
      const firstSeparator = l.indexOf('separator');
      assert.ok(firstSeparator > 0);
      assert.ok(l.indexOf('cut') > firstSeparator, 'editing items must sit below the separator');
    });

    test('a misspelling the OS has no suggestions for still offers the dictionary', () => {
      // Hunspell returns an empty list for many proper nouns. Offering nothing
      // at all would make the underline look like a dead end.
      const t = buildContextMenuTemplate(params({ misspelledWord: 'Rundock', dictionarySuggestions: [] }));
      const a = actions(t);
      assert.ok(a.some((x) => x.type === 'addToDictionary' && x.word === 'Rundock'));
      assert.ok(!a.some((x) => x.type === 'replaceMisspelling'));
      assert.ok(labels(t).includes('cut'), 'the editing items must still be there');
    });

    test('correctly spelled text gets the editing items and nothing spelling-related', () => {
      const t = buildContextMenuTemplate(params());
      assert.deepStrictEqual(actions(t), []);
      assert.ok(labels(t).includes('paste'));
    });

    test('never begins or ends with a separator', () => {
      for (const p of [params(), misspelled()]) {
        const l = labels(buildContextMenuTemplate(p));
        assert.notStrictEqual(l[0], 'separator');
        assert.notStrictEqual(l[l.length - 1], 'separator');
      }
    });
  });

  describe('total: it runs on every right-click in the app', () => {
    test('malformed or partial params yield null rather than throwing', () => {
      for (const junk of [null, undefined, {}, 'nonsense', 42, { isEditable: true }]) {
        assert.doesNotThrow(() => buildContextMenuTemplate(junk));
      }
    });

    test('an editable target with no editFlags still produces a usable menu', () => {
      // Defensive: params should always carry editFlags, but a menu with
      // everything disabled is better than a crash in the main process.
      const t = buildContextMenuTemplate({ isEditable: true });
      assert.ok(Array.isArray(t));
      assert.ok(labels(t).includes('copy'));
    });
  });
});
