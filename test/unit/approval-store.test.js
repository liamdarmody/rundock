'use strict';
// Unit: where a routine's approval counts (lib/agents/approval-store.js and
// lib/agents/approval-locality.js), and the strip that names the routines a
// workspace arrived with (public/held-routines-model.js).
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../lib/agents/approval-store.js');
const locality = require('../../lib/agents/approval-locality.js');
const { computePlanHash, normalizeRoutine, parseRoutineBlocks } = require('../../lib/agents/routines.js');
const { agentFile } = require('../helpers/workspace.js');

function tempDir(prefix) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }
const routine = (over = {}) => ({ name: 'digest', prompt: 'go', runOn: 'local', source: { file: '.claude/agents/piper.md', occurrence: 0 }, ...over });

function withStoreFile(fn) {
  const dir = tempDir('approval-store-');
  store.configureApprovalStore(path.join(dir, 'approvals.json'));
  try { return fn(dir); } finally { store.configureApprovalStore(null); fs.rmSync(dir, { recursive: true, force: true }); }
}

function workspaceWith(routines, { approved = true } = {}) {
  const dir = tempDir('approval-ws-');
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  const draft = agentFile({ name: 'piper', type: 'specialist', order: 1, routines });
  const blocks = parseRoutineBlocks(draft.match(/^---\n([\s\S]*?)\n---/)[1]);
  const withHash = approved
    ? routines.map((r, i) => ({ ...r, planApprovedHash: computePlanHash(normalizeRoutine(blocks[i])) }))
    : routines;
  fs.writeFileSync(path.join(dir, '.claude', 'agents', 'piper.md'), agentFile({ name: 'piper', displayName: 'Piper', type: 'specialist', order: 1, routines: withHash }));
  return dir;
}

describe('the record', () => {
  test('an approval counts for the plan it was given over, in the workspace it was given in, and nowhere else', () => withStoreFile(() => {
    const a = tempDir('ws-a-');
    const b = tempDir('ws-b-');
    const r = routine();
    store.recordApproval(a, store.identityOf(r), computePlanHash(r), null);
    assert.strictEqual(store.approvedHere(a, r, computePlanHash(r)), true);
    assert.strictEqual(store.approvedHere(b, r, computePlanHash(r)), false, 'not in another workspace');
    assert.strictEqual(store.approvedHere(a, { ...r, prompt: 'other' }, computePlanHash({ ...r, prompt: 'other' })), false, 'not for a changed plan');
    assert.strictEqual(store.approvedHereBefore(a, { ...r, prompt: 'other' }), true, 'but it was approved before');
    assert.strictEqual(store.approvedHere(a, { ...r, source: { file: '.claude/agents/piper.md', occurrence: 1 } }, computePlanHash(r)), false, 'not for its namesake');
    assert.strictEqual(store.approvedHere(a, { ...r, source: undefined }, computePlanHash(r)), false, 'nor for a routine with no identity');
  }));

  test('a workspace is one workspace under any spelling of its path', () => withStoreFile(() => {
    const a = tempDir('ws-real-');
    const alias = `${a}-alias`;
    fs.symlinkSync(a, alias);
    const r = routine();
    store.recordApproval(alias, store.identityOf(r), computePlanHash(r), null);
    assert.strictEqual(store.approvedHere(a, r, computePlanHash(r)), true);
  }));

  test('the moment is kept, and an approval carried over at upgrade has none', () => withStoreFile(() => {
    const a = tempDir('ws-at-');
    store.recordApproval(a, store.identityOf(routine()), 'h', '2026-07-01T08:00:00.000Z');
    assert.strictEqual(store.approvedAt(a, routine()).toISOString(), '2026-07-01T08:00:00.000Z');
    store.recordApproval(a, store.identityOf(routine()), 'h', null);
    assert.strictEqual(store.approvedAt(a, routine()), null);
  }));

  test('it lives in its own file, outside every workspace, and survives a restart', () => withStoreFile((home) => {
    const a = tempDir('ws-file-');
    store.recordApproval(a, store.identityOf(routine()), 'h', null);
    store.configureApprovalStore(path.join(home, 'approvals.json'));
    assert.strictEqual(store.approvedHere(a, routine(), 'h'), true);
    assert.ok(!fs.readdirSync(a).length, 'nothing was written into the workspace');
  }));
});

describe('the first open of a workspace', () => {
  test('a state file naming the workspace is not enough: this install must have opened it before it kept approvals', () => withStoreFile(() => {
    const dir = workspaceWith([{ name: 'on', schedule: 'every day at 07:00', prompt: 'go', enabled: true }]);
    assert.strictEqual(locality.noteWorkspaceOpened(dir, dir), 'unseen');
  }));

  test('a path this install had opened is not enough either: the folder there must say it was opened there', () => withStoreFile(() => {
    // A folder replaced, at the same place, by a fresh clone carrying no
    // state of its own.
    const dir = workspaceWith([{ name: 'on', schedule: 'every day at 07:00', prompt: 'go', enabled: true }]);
    store.markRecentBeforeStore(dir);
    assert.strictEqual(locality.noteWorkspaceOpened(dir, null), 'unseen');
  }));

  test('the record keeps the recent-workspaces list as it was when the record was made, and only then', () => {
    const home = tempDir('approval-recent-');
    const listed = tempDir('ws-listed-');
    const later = tempDir('ws-later-');
    const file = path.join(home, 'approvals.json');
    try {
      store.configureApprovalStore(file, { recentPaths: () => [listed] });
      assert.strictEqual(store.wasRecentBeforeStore(listed), true);
      store.configureApprovalStore(file, { recentPaths: () => [listed, later] });
      assert.strictEqual(store.wasRecentBeforeStore(later), false, 'a workspace opened after the record existed is not history');
    } finally { store.configureApprovalStore(null); }
  });

  test('one this machine opened at this path before keeps its approvals and its pre-approval routines', () => withStoreFile(() => {
    const dir = workspaceWith([{ name: 'running', schedule: 'every day at 07:00', prompt: 'go', enabled: true }], { approved: false });
    store.markRecentBeforeStore(dir);
    assert.strictEqual(locality.noteWorkspaceOpened(dir, dir), 'adopted');
    const [e] = locality.routinesIn(dir);
    assert.strictEqual(store.approvedHere(dir, { ...e.routine, source: { file: e.file, occurrence: 0 } }, computePlanHash(e.routine)), true);
    assert.deepStrictEqual(locality.heldForStrip(dir), [], 'and nobody is asked');
  }));

  test('any other is unseen: nothing it carries is approved, and what would have run is held for the strip', () => withStoreFile(() => {
    const dir = workspaceWith([
      { name: 'on', schedule: 'every day at 07:00', prompt: 'go', enabled: true },
      { name: 'off', schedule: 'every day at 07:00', prompt: 'go', enabled: false },
      { name: 'paused', schedule: 'every day at 07:00', prompt: 'go', enabled: true, paused: true },
    ]);
    assert.strictEqual(locality.noteWorkspaceOpened(dir, '/somewhere/else'), 'unseen');
    const [on] = locality.routinesIn(dir);
    assert.strictEqual(store.approvedHere(dir, { ...on.routine, source: { file: on.file, occurrence: 0 } }, computePlanHash(on.routine)), false);
    assert.deepStrictEqual(locality.heldForStrip(dir), [{ name: 'on', agentId: 'piper', agent: 'Piper' }], 'only a routine that would have run');
  }));

  test('decided once: a second open changes nothing', () => withStoreFile(() => {
    const dir = workspaceWith([{ name: 'on', schedule: 'every day at 07:00', prompt: 'go', enabled: true }]);
    locality.noteWorkspaceOpened(dir, null);
    assert.strictEqual(locality.noteWorkspaceOpened(dir, dir), 'unseen');
  }));

  test('moved, with the old path gone, its records follow; copied, they do not', () => withStoreFile(() => {
    const dir = workspaceWith([{ name: 'on', schedule: 'every day at 07:00', prompt: 'go', enabled: true }]);
    store.markRecentBeforeStore(dir);
    locality.noteWorkspaceOpened(dir, dir);
    const copy = `${dir}-copy`;
    fs.cpSync(dir, copy, { recursive: true });
    assert.strictEqual(locality.noteWorkspaceOpened(copy, dir), 'unseen', 'a copy is unseen');
    const moved = `${dir}-moved`;
    fs.renameSync(dir, moved);
    assert.strictEqual(locality.noteWorkspaceOpened(moved, dir), 'adopted', 'a move keeps the state');
    const [e] = locality.routinesIn(moved);
    assert.strictEqual(store.approvedHere(moved, { ...e.routine, source: { file: e.file, occurrence: 0 } }, computePlanHash(e.routine)), true);
  }));

  test('Allow approves what the strip names, now, and closes it; Close leaves them held', () => withStoreFile(() => {
    const dir = workspaceWith([{ name: 'on', schedule: 'every day at 07:00', prompt: 'go', enabled: true }]);
    locality.noteWorkspaceOpened(dir, null);
    const other = workspaceWith([{ name: 'on', schedule: 'every day at 07:00', prompt: 'go', enabled: true }]);
    locality.noteWorkspaceOpened(other, null);
    locality.allowHeld(dir, '2026-07-01T09:00:00.000Z');
    const [e] = locality.routinesIn(dir);
    const r = { ...e.routine, source: { file: e.file, occurrence: 0 } };
    assert.strictEqual(store.approvedHere(dir, r, computePlanHash(e.routine)), true);
    assert.strictEqual(store.approvedAt(dir, r).toISOString(), '2026-07-01T09:00:00.000Z');
    assert.deepStrictEqual(locality.heldForStrip(dir), []);
    store.closeStrip(other);
    assert.deepStrictEqual(locality.heldForStrip(other), []);
    assert.strictEqual(store.approvedHere(other, { ...r }, computePlanHash(e.routine)), false, 'closing approves nothing');
  }));

  test('a package install records no approval a file does not carry for its plan', () => withStoreFile(() => {
    const dir = workspaceWith([{ name: 'on', schedule: 'every day at 07:00', prompt: 'go', enabled: true }], { approved: false });
    locality.recordFileApprovals(dir, '.claude/agents/piper.md', '2026-07-01T09:00:00.000Z', [{ name: 'on', occurrence: 0 }]);
    const [e] = locality.routinesIn(dir);
    assert.strictEqual(store.approvedHere(dir, { ...e.routine, source: { file: e.file, occurrence: 0 } }, computePlanHash(e.routine)), false);
  }));

  test('a package install records only what its card said runs itself, in that workspace only', () => withStoreFile(() => {
    const dir = workspaceWith([{ name: 'on', schedule: 'every day at 07:00', prompt: 'go', enabled: true }]);
    locality.recordFileApprovals(dir, '.claude/agents/piper.md', '2026-07-01T09:00:00.000Z', []);
    const [f] = locality.routinesIn(dir);
    assert.strictEqual(store.approvedHere(dir, { ...f.routine, source: { file: f.file, occurrence: 0 } }, computePlanHash(f.routine)), false, 'a routine the card did not name is not approved');
    locality.recordFileApprovals(dir, '.claude/agents/piper.md', '2026-07-01T09:00:00.000Z', [{ name: 'on', occurrence: 0 }]);
    const [e] = locality.routinesIn(dir);
    assert.strictEqual(store.approvedHere(dir, { ...e.routine, source: { file: e.file, occurrence: 0 } }, computePlanHash(e.routine)), true);
  }));
});

describe('public/held-routines-model: the strip\'s words', () => {
  const m = require('../../public/held-routines-model.js');
  test('names every routine with its agent, and the button fits the count', () => {
    assert.strictEqual(m.heldStrip([]), null);
    assert.deepStrictEqual(m.heldStrip([{ name: 'Inbox sweep', agent: 'Wren' }, { name: 'Weekly digest', agent: 'Reese' }]), {
      text: 'This workspace came with 2 routines switched on: Inbox sweep (Wren) and Weekly digest (Reese). They won\'t run on this computer until you allow them.',
      allowLabel: 'Allow both', reviewLabel: 'Review', closeLabel: 'Close',
    });
    assert.strictEqual(m.heldStrip([{ name: 'A', agent: 'X' }]).text, 'This workspace came with a routine switched on: A (X). It won\'t run on this computer until you allow it.');
    assert.strictEqual(m.heldStrip([{ name: 'A', agent: 'X' }]).allowLabel, 'Allow it');
    const three = m.heldStrip([{ name: 'A', agent: 'X' }, { name: 'B', agent: 'Y' }, { name: 'C', agent: 'Z' }]);
    assert.match(three.text, /3 routines switched on: A \(X\), B \(Y\) and C \(Z\)\./);
    assert.strictEqual(three.allowLabel, 'Allow all');
  });
});

describe('the strip on the page', () => {
  test('draws the line and three controls from the model, sends the two answers, and hides when there is nothing', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="held-strip" hidden></div></body>', { runScripts: 'outside-only' });
    const w = dom.window;
    w.RundockHeldRoutines = require('../../public/held-routines-model.js');
    const sent = [];
    w.ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m).type) };
    let navigated = null;
    w.switchNav = (v) => { navigated = v; };
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'public', 'views', 'routines.js'), 'utf-8');
    w.eval(src);
    w.renderHeldStrip([{ name: '<b>Sweep</b>', agent: 'Wren' }]);
    const el = w.document.getElementById('held-strip');
    assert.strictEqual(el.hidden, false);
    assert.match(el.querySelector('.held-strip-text').textContent, /<b>Sweep<\/b> \(Wren\)/, 'names are text, never markup');
    assert.strictEqual(el.querySelector('b'), null);
    const [allow, review, close] = el.querySelectorAll('button');
    assert.strictEqual(allow.textContent, 'Allow it');
    allow.click(); close.click(); review.click();
    assert.deepStrictEqual(sent, ['allow_held_routines', 'dismiss_held_routines']);
    assert.strictEqual(navigated, 'routines');
    assert.strictEqual(close.getAttribute('aria-label'), 'Close');
    w.renderHeldStrip([]);
    assert.strictEqual(el.hidden, true);
    assert.strictEqual(el.children.length, 0);
  });
});
