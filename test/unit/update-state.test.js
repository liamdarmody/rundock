// Tests for the updater's decision logic (electron/update-state.js).
//
// This module exists so the question "given what we know about an update,
// what should the user see?" can be answered and tested without Electron,
// following the convention of public/chrome-insets.js, public/code-language.js
// and electron/context-menu-template.js. Only the wiring stays untestable.
//
// The invariant every one of these tests defends: there is no path where the
// interface claims an update will be installed and it then is not. That claim
// is exactly what the shipped dialog got wrong.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { decideUpdateUi, PHASES } = require('../../electron/update-state.js');

const base = { phase: 'idle', percent: 0, version: null, manual: false, launchesSinceDownload: 0 };
const at = (over) => decideUpdateUi({ ...base, ...over });

describe('an unasked-for check never interrupts', () => {
  test('idle shows nothing', () => {
    assert.strictEqual(at({ phase: 'idle' }).kind, 'none');
  });

  test('an automatic check in progress shows nothing', () => {
    assert.strictEqual(at({ phase: 'checking', manual: false }).kind, 'none');
  });

  test('an automatic check finding an update shows progress, never a dialog', () => {
    const ui = at({ phase: 'available', manual: false, version: '0.11.5' });
    assert.strictEqual(ui.kind, 'progress');
    assert.strictEqual(ui.dialog, undefined);
  });

  test('an automatic check that errors stays silent', () => {
    // Nagging about a failure the user never asked for trains them to dismiss
    // update messages unread, which is the opposite of what we need.
    assert.strictEqual(at({ phase: 'error', manual: false }).kind, 'none');
  });
});

describe('a check the user asked for always answers', () => {
  test('finding an update confirms the download started', () => {
    const ui = at({ phase: 'available', manual: true, version: '0.11.5' });
    assert.strictEqual(ui.kind, 'progress');
    assert.ok(ui.dialog, 'a manual check must acknowledge itself');
    assert.match(ui.dialog.message, /0\.11\.5/);
  });

  test('an error the user asked for is reported', () => {
    const ui = at({ phase: 'error', manual: true, error: 'ENOTFOUND rundock.ai' });
    assert.strictEqual(ui.kind, 'dialog');
    assert.match(ui.dialog.detail, /ENOTFOUND/);
  });

  test('an unreachable feed reports failure rather than appearing to succeed', () => {
    const ui = at({ phase: 'error', manual: true, error: 'connect ECONNREFUSED 127.0.0.1:8384' });
    assert.strictEqual(ui.kind, 'dialog');
    assert.match(ui.dialog.message, /could not check/i);
    assert.doesNotMatch(JSON.stringify(ui), /up to date/i, 'a failed check must never read as success');
  });
});

describe('waiting is legible', () => {
  test('downloading reports a real percentage', () => {
    const ui = at({ phase: 'downloading', percent: 42.7 });
    assert.strictEqual(ui.kind, 'progress');
    assert.strictEqual(ui.percent, 43, 'rounded for display');
    assert.strictEqual(ui.indeterminate, false);
  });

  test('downloading before the first progress event is honest about not knowing', () => {
    const ui = at({ phase: 'downloading', percent: null });
    assert.strictEqual(ui.kind, 'progress');
    assert.strictEqual(ui.indeterminate, true);
  });

  test('percent is clamped, because a bad event should not render nonsense', () => {
    assert.strictEqual(at({ phase: 'downloading', percent: 150 }).percent, 100);
    assert.strictEqual(at({ phase: 'downloading', percent: -5 }).percent, 0);
  });

  test('progress copy tells the user that waiting is the correct action', () => {
    const ui = at({ phase: 'downloading', percent: 10 });
    assert.match(ui.text, /download/i);
    // The shipped bug: the user quit because nothing said "keep waiting", and
    // quitting restarted the download. The copy has to earn the wait.
    assert.doesNotMatch(ui.text, /next quit/i);
  });
});

describe('the install is one deliberate action, not a race', () => {
  test('a downloaded update offers Restart now and Later', () => {
    const ui = at({ phase: 'downloaded', version: '0.11.5' });
    assert.strictEqual(ui.kind, 'ready');
    assert.deepStrictEqual(ui.buttons, ['Restart now', 'Later']);
    assert.strictEqual(ui.defaultId, 0);
  });

  test('choosing Restart now is what triggers the install', () => {
    const ui = at({ phase: 'downloaded', version: '0.11.5' });
    assert.strictEqual(ui.actions[0], 'quitAndInstall');
  });

  test('the ready copy never promises an install that has not been asked for', () => {
    const ui = at({ phase: 'downloaded', version: '0.11.5' });
    // "will install on next quit" was the untrue claim. Whatever the copy
    // says, it must not assert a future install as a fact.
    assert.doesNotMatch(ui.text, /will install/i);
    assert.doesNotMatch(ui.text, /on next quit/i);
  });
});

describe('the escape hatch assumes the fix is imperfect', () => {
  test('one or two launches after download still just offers the restart', () => {
    for (const n of [0, 1, 2]) {
      assert.strictEqual(at({ phase: 'downloaded', launchesSinceDownload: n }).kind, 'ready');
    }
  });

  test('by the third launch it admits the update is not installing', () => {
    const ui = at({ phase: 'downloaded', version: '0.11.5', launchesSinceDownload: 3 });
    assert.strictEqual(ui.kind, 'stuck');
    assert.ok(ui.downloadUrl, 'the way out must not itself depend on the updater');
  });

  test('the stuck message says plainly what happened', () => {
    const ui = at({ phase: 'downloaded', launchesSinceDownload: 5 });
    assert.match(ui.text, /downloaded/i);
    assert.match(ui.text, /not.*install|has not/i);
  });

  test('the stuck state still offers the restart, since it may yet work', () => {
    const ui = at({ phase: 'downloaded', launchesSinceDownload: 4 });
    assert.ok(ui.actions.includes('quitAndInstall'));
  });
});

describe('contract hygiene', () => {
  test('every phase is handled, so a new one cannot fall through silently', () => {
    for (const phase of PHASES) {
      for (const manual of [true, false]) {
        const ui = decideUpdateUi({ ...base, phase, manual });
        assert.ok(ui && typeof ui.kind === 'string', `${phase}/${manual} returned no kind`);
      }
    }
  });

  test('an unknown phase fails closed to silence rather than throwing', () => {
    // A crash in the updater path would be worse than showing nothing.
    assert.strictEqual(decideUpdateUi({ ...base, phase: 'wat' }).kind, 'none');
  });

  test('missing input does not throw', () => {
    assert.strictEqual(decideUpdateUi({}).kind, 'none');
    assert.strictEqual(decideUpdateUi().kind, 'none');
  });
});
