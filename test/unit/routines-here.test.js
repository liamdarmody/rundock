'use strict';
// Routines off on this computer, for one workspace: the record that holds it,
// and the one server route that changes it.
//
// The record is this install's own, outside every workspace, keyed by the
// workspace's path on this computer, so it never syncs and never reaches a
// second workspace. On is the default and the answer whenever the record
// cannot be read. What the scheduler does with it is driven tick by tick in
// test/integration/routines-off-here.test.js.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const here = require('../../lib/agents/routines-here.js');
const config = require('../../lib/config.js');
const { handleSetRoutinesHere } = require('../../lib/protocol/handlers/routines-here.js');
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const { rosterMessage } = require('../../lib/agents/discovery.js');

// A made-up computer name. Nothing here reads the machine it runs on.
const COMPUTER = 'quartz-desk';

let tmp;
let record;
let previousName;
let previousWorkspace;

function workspace(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# A workspace\n');
  return dir;
}

// Every file in a folder, with its bytes, so "nothing was written here" is a
// comparison rather than a belief.
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else out[child] = fs.readFileSync(path.join(dir, child)).toString('base64');
    }
  };
  walk('');
  return out;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'routines-here-')));
  record = path.join(tmp, 'install', 'routines-here.json');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  here.configureRoutinesHere(record);
  previousName = here.wireHostname(() => `${COMPUTER}.local`);
  previousWorkspace = config.getWorkspace();
});

afterEach(() => {
  here.wireHostname(previousName);
  config.setWorkspace(previousWorkspace);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the record: one workspace on one computer', () => {
  test('routines are on until somebody turns them off', () => {
    const dir = workspace('ledger');
    assert.strictEqual(here.offHere(dir), false);
    assert.ok(!fs.existsSync(record), 'reading the default writes nothing');
  });

  test('turning them off for one workspace leaves another on this computer on', () => {
    const ledger = workspace('ledger');
    const notes = workspace('notes');
    here.setOffHere(ledger, true);
    assert.strictEqual(here.offHere(ledger), true);
    assert.strictEqual(here.offHere(notes), false, 'a second workspace on this computer was turned off too');
  });

  test('the key is the workspace\'s path, so another spelling of the same folder is the same workspace', () => {
    const ledger = workspace('ledger');
    const link = path.join(tmp, 'ledger-link');
    fs.symlinkSync(ledger, link);
    here.setOffHere(link, true);
    assert.strictEqual(here.offHere(ledger), true, 'the folder reached through a link is a different workspace');
    const held = JSON.parse(fs.readFileSync(record, 'utf-8'));
    assert.deepStrictEqual(Object.keys(held.workspaces), [ledger], 'keyed by the real path, and by nothing else');
  });

  test('it is kept outside the workspace, and the workspace is byte for byte as it was', () => {
    const ledger = workspace('ledger');
    const before = snapshot(ledger);
    here.setOffHere(ledger, true);
    assert.deepStrictEqual(snapshot(ledger), before, 'turning routines off wrote into the workspace');
    here.setOffHere(ledger, false);
    assert.deepStrictEqual(snapshot(ledger), before, 'turning them on wrote into the workspace');
    assert.ok(path.relative(ledger, record).startsWith('..'), 'the record is outside the workspace');
  });

  test('a moved workspace starts on, as a new one does', () => {
    const ledger = workspace('ledger');
    here.setOffHere(ledger, true);
    const moved = path.join(tmp, 'ledger-moved');
    fs.renameSync(ledger, moved);
    assert.strictEqual(here.offHere(moved), false);
  });
});

describe('the retry: asking twice changes nothing more', () => {
  test('off twice leaves one record, and the second writes nothing', () => {
    const ledger = workspace('ledger');
    assert.strictEqual(here.setOffHere(ledger, true), true, 'the first turns it off');
    const first = fs.readFileSync(record, 'utf-8');
    const stat = fs.statSync(record);
    assert.strictEqual(here.setOffHere(ledger, true), false, 'the second has nothing to do');
    assert.strictEqual(fs.readFileSync(record, 'utf-8'), first);
    assert.strictEqual(fs.statSync(record).mtimeMs, stat.mtimeMs, 'the record was written again');
    assert.strictEqual(Object.keys(JSON.parse(first).workspaces).length, 1);
  });

  test('on when it is already on writes nothing at all', () => {
    const ledger = workspace('ledger');
    assert.strictEqual(here.setOffHere(ledger, false), false);
    assert.ok(!fs.existsSync(record), 'turning on what was on created the record');
  });

  test('on after off is the default again', () => {
    const ledger = workspace('ledger');
    here.setOffHere(ledger, true);
    here.setOffHere(ledger, false);
    assert.strictEqual(here.offHere(ledger), false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(record, 'utf-8')).workspaces, {});
  });
});

describe('the path failing', () => {
  test('a record that does not parse is set aside, and routines read on', () => {
    const ledger = workspace('ledger');
    fs.writeFileSync(record, `{"workspaces": {"${ledger}": {"off": true}`);
    const said = [];
    const error = console.error;
    console.error = (line) => said.push(String(line));
    let off;
    try { off = here.offHere(ledger); } finally { console.error = error; }
    assert.strictEqual(off, false, 'a record nobody can read turned routines off');
    assert.ok(!fs.existsSync(record), 'the unreadable record is still under its own name');
    const aside = fs.readdirSync(path.dirname(record)).filter(n => n.startsWith('routines-here.json.unparsed-'));
    assert.strictEqual(aside.length, 1, 'the record was not kept under a dated name');
    assert.ok(said.some(l => l.includes('set aside')), 'nothing said the record was set aside');
  });

  test('a record that cannot be read at all reads on', () => {
    const ledger = workspace('ledger');
    fs.mkdirSync(record);
    const error = console.error;
    console.error = () => {};
    try { assert.strictEqual(here.offHere(ledger), false); } finally { console.error = error; }
  });

  test('a record of the wrong shape reads on', () => {
    const ledger = workspace('ledger');
    fs.writeFileSync(record, JSON.stringify({ workspaces: [ledger] }));
    assert.strictEqual(here.offHere(ledger), false);
  });

  test('a write that fails throws, and leaves the previous record whole', (t) => {
    const ledger = workspace('ledger');
    const notes = workspace('notes');
    here.setOffHere(notes, true);
    const before = fs.readFileSync(record, 'utf-8');
    t.mock.method(fs, 'renameSync', () => { const e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e; });
    assert.throws(() => here.setOffHere(ledger, true), /no space left/);
    t.mock.restoreAll();
    assert.strictEqual(fs.readFileSync(record, 'utf-8'), before, 'the record changed after a failed write');
    assert.strictEqual(here.offHere(ledger), false, 'the workspace reads as it was');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(record)), ['routines-here.json'], 'a temporary file was left beside it');
  });
});

describe('the computer\'s name', () => {
  test('is the server\'s, without the .local a Mac adds', () => {
    assert.strictEqual(here.computerName(), COMPUTER);
  });

  test('is nothing when none can be read', () => {
    here.wireHostname(() => '');
    assert.strictEqual(here.computerName(), null);
    here.wireHostname(() => { throw new Error('no name'); });
    assert.strictEqual(here.computerName(), null);
  });

  test('travels on the roster with the switch\'s state, for the workspace that is open', () => {
    const ledger = workspace('ledger');
    config.setWorkspace(ledger);
    assert.deepStrictEqual(rosterMessage([]).routinesHere, { off: false, computer: COMPUTER });
    here.setOffHere(ledger, true);
    assert.deepStrictEqual(rosterMessage([]).routinesHere, { off: true, computer: COMPUTER });
  });
});

describe('set_routines_here: the one way the switch changes', () => {
  function window() {
    const sent = [];
    return { sent, send: (text) => sent.push(JSON.parse(text)) };
  }
  function context() {
    const broadcast = [];
    return { broadcast: (text) => broadcast.push(JSON.parse(text)), told: broadcast };
  }

  test('is in the dispatch table', () => {
    assert.strictEqual(buildDispatch().set_routines_here, handleSetRoutinesHere);
  });

  test('turns routines off for the open workspace and tells every window', () => {
    const ledger = workspace('ledger');
    config.setWorkspace(ledger);
    const ws = window();
    const ctx = context();
    handleSetRoutinesHere(ctx, ws, { type: 'set_routines_here', on: false, workspace: ledger });
    assert.strictEqual(here.offHere(ledger), true);
    assert.deepStrictEqual(ws.sent, [], 'the window that asked was answered on its own');
    assert.strictEqual(ctx.told.length, 1);
    assert.strictEqual(ctx.told[0].type, 'agents');
    assert.deepStrictEqual(ctx.told[0].routinesHere, { off: true, computer: COMPUTER });

    handleSetRoutinesHere(ctx, ws, { type: 'set_routines_here', on: true, workspace: ledger });
    assert.strictEqual(here.offHere(ledger), false);
    assert.deepStrictEqual(ctx.told[1].routinesHere, { off: false, computer: COMPUTER });
  });

  test('refuses with no workspace open, an answer that is not on or off, or a window on another workspace', () => {
    const ledger = workspace('ledger');
    const notes = workspace('notes');
    for (const [open, msg] of [
      [null, { on: false, workspace: ledger }],
      [ledger, { on: 'no', workspace: ledger }],
      [ledger, { workspace: ledger }],
      [ledger, { on: false, workspace: notes }],
      [ledger, { on: false }],
    ]) {
      config.setWorkspace(open);
      const ws = window();
      const ctx = context();
      handleSetRoutinesHere(ctx, ws, { type: 'set_routines_here', ...msg });
      assert.strictEqual(ws.sent.length, 1, `${JSON.stringify(msg)} was not answered`);
      assert.strictEqual(ws.sent[0].type, 'routines_here_failed');
      assert.deepStrictEqual(ctx.told, [], `${JSON.stringify(msg)} told every window something changed`);
    }
    assert.strictEqual(here.offHere(ledger), false);
    assert.strictEqual(here.offHere(notes), false);
    assert.ok(!fs.existsSync(record), 'a refused request wrote the record');
  });

  test('a save that fails is said to the window that asked, and nothing moves', (t) => {
    const ledger = workspace('ledger');
    config.setWorkspace(ledger);
    const ws = window();
    const ctx = context();
    const error = console.error;
    console.error = () => {};
    t.mock.method(fs, 'renameSync', () => { throw new Error('permission denied'); });
    try {
      handleSetRoutinesHere(ctx, ws, { type: 'set_routines_here', on: false, workspace: ledger });
    } finally {
      t.mock.restoreAll();
      console.error = error;
    }
    assert.deepStrictEqual(ws.sent, [{ type: 'routines_here_failed', on: false, detail: 'permission denied' }]);
    assert.deepStrictEqual(ctx.told, []);
    assert.strictEqual(here.offHere(ledger), false);
  });
});
