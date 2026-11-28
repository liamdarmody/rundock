'use strict';
// A card approved for a command outside the sandbox leaves one grant in the
// server's memory: one use of that exact command, in that conversation, by that
// agent, with that tool, within a minute of the click. These cases drive the
// grant module directly, with its clock patched in-process.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODULE = path.join(ROOT, 'lib', 'runtime', 'sandbox-grants.js');

// Required with a guard, so a missing module fails the assertion below rather
// than the whole file.
let loaded = null;
try { loaded = require(MODULE); } catch (e) { loaded = null; }

function grants() {
  assert.ok(loaded, 'lib/runtime/sandbox-grants.js exists');
  for (const name of ['GRANT_WINDOW_MS', 'recordGrant', 'spendGrant', 'wasApproved', 'seams']) {
    assert.ok(name in loaded, `it exports ${name}`);
  }
  return loaded;
}

const realNow = loaded && loaded.seams ? loaded.seams.now : null;
afterEach(() => { if (loaded && loaded.seams) loaded.seams.now = realNow; });

let n = 0;
const newConvo = () => `convo-grants-${process.pid}-${++n}`;
const grant = (conversationId, over = {}) => ({
  conversationId,
  agentId: 'default',
  toolName: 'Bash',
  toolInput: { command: 'echo hello', dangerouslyDisableSandbox: true },
  ...over,
});
const at = (ms) => { grants().seams.now = () => ms; };

describe('a grant for one command outside the sandbox', () => {
  test('the window is one minute', () => {
    assert.strictEqual(grants().GRANT_WINDOW_MS, 60000);
  });

  test('a grant is spent once', () => {
    const g = grants();
    const c = newConvo();
    assert.strictEqual(g.recordGrant(grant(c)), true, 'recorded');
    assert.strictEqual(g.spendGrant(grant(c)), true, 'the first ask spends it');
    assert.strictEqual(g.spendGrant(grant(c)), false, 'the second finds nothing');
  });

  test('two approvals of one command make two grants, one use each', () => {
    const g = grants();
    const c = newConvo();
    g.recordGrant(grant(c));
    g.recordGrant(grant(c));
    assert.strictEqual(g.spendGrant(grant(c)), true);
    assert.strictEqual(g.spendGrant(grant(c)), true);
    assert.strictEqual(g.spendGrant(grant(c)), false);
  });

  test('a grant answers only its own conversation, agent, tool, exact command and flag', () => {
    const g = grants();
    const c = newConvo();
    g.recordGrant(grant(c));
    const misses = {
      'another conversation': grant(newConvo()),
      'another agent': grant(c, { agentId: 'example-alpha' }),
      'another tool': grant(c, { toolName: 'PowerShell' }),
      'one character changed': grant(c, { toolInput: { command: 'echo hellp', dangerouslyDisableSandbox: true } }),
      'a space added': grant(c, { toolInput: { command: 'echo hello ', dangerouslyDisableSandbox: true } }),
      'no flag': grant(c, { toolInput: { command: 'echo hello' } }),
      'the flag as a string': grant(c, { toolInput: { command: 'echo hello', dangerouslyDisableSandbox: 'true' } }),
    };
    for (const [why, ask] of Object.entries(misses)) assert.strictEqual(g.spendGrant(ask), false, why);
    assert.strictEqual(g.spendGrant(grant(c)), true, 'and none of those spent it');
  });

  test('the window: a grant 59 s old spends, one 60 s old does not', () => {
    const g = grants();
    const c = newConvo();
    at(1000000);
    g.recordGrant(grant(c));
    at(1000000 + 59000);
    assert.strictEqual(g.spendGrant(grant(c)), true, '59 s');
    at(1000000);
    g.recordGrant(grant(c));
    at(1000000 + 59999);
    assert.strictEqual(g.spendGrant(grant(c)), true, 'a millisecond short of the minute');
    at(1000000);
    g.recordGrant(grant(c));
    at(1000000 + 60000);
    assert.strictEqual(g.spendGrant(grant(c)), false, '60 s');
  });

  test('a grant past the window is dropped when another is recorded', () => {
    const g = grants();
    const old = newConvo();
    at(0);
    g.recordGrant(grant(old));
    at(70000);
    g.recordGrant(grant(newConvo()));
    // With the clock turned back, an entry still held would count as live.
    at(1000);
    assert.strictEqual(g.spendGrant(grant(old)), false, 'the expired grant is gone');
    assert.strictEqual(g.wasApproved(grant(old)), false, 'and so is its approval');
  });

  test('a grant past the window is dropped when one is spent', () => {
    const g = grants();
    const old = newConvo();
    at(0);
    g.recordGrant(grant(old));
    at(70000);
    assert.strictEqual(g.spendGrant(grant(newConvo())), false, 'nothing to spend here');
    at(1000);
    assert.strictEqual(g.spendGrant(grant(old)), false, 'the expired grant is gone');
  });

  test('an approval is remembered within the window, spent or not, for that command only', () => {
    const g = grants();
    const c = newConvo();
    at(5000000);
    assert.strictEqual(g.wasApproved(grant(c)), false, 'nothing approved yet');
    g.recordGrant(grant(c));
    assert.strictEqual(g.wasApproved(grant(c)), true, 'approved, not yet spent');
    g.spendGrant(grant(c));
    assert.strictEqual(g.wasApproved(grant(c)), true, 'approved and spent');
    assert.strictEqual(g.wasApproved(grant(c, { toolInput: { command: 'echo other', dangerouslyDisableSandbox: true } })), false, 'another command');
    assert.strictEqual(g.wasApproved(grant(newConvo())), false, 'another conversation');
    at(5000000 + 60000);
    assert.strictEqual(g.wasApproved(grant(c)), false, 'past the window');
  });

  test('a grant that names no conversation, agent, shell tool, command or exact flag is never recorded', () => {
    const g = grants();
    const c = newConvo();
    const bad = [
      null,
      'Bash',
      grant(''),
      grant(undefined),
      grant(c, { agentId: '' }),
      grant(c, { agentId: null }),
      grant(c, { toolName: 'Write' }),
      grant(c, { toolName: 'bash' }),
      grant(c, { toolInput: null }),
      grant(c, { toolInput: { command: '', dangerouslyDisableSandbox: true } }),
      grant(c, { toolInput: { command: ['echo', 'hello'], dangerouslyDisableSandbox: true } }),
      grant(c, { toolInput: { command: 'echo hello', dangerouslyDisableSandbox: 'true' } }),
      grant(c, { toolInput: { command: 'echo hello', dangerouslyDisableSandbox: 1 } }),
    ];
    for (const b of bad) {
      assert.strictEqual(g.recordGrant(b), false, JSON.stringify(b));
      assert.strictEqual(g.spendGrant(b), false, JSON.stringify(b));
    }
    assert.strictEqual(g.spendGrant(grant(c)), false, 'and nothing was recorded for the well-formed key either');
  });
});

describe('only the card answer records a grant', () => {
  // Every source file outside test/ is read; the only one that may call the
  // record function is the card-answer handler.
  const SKIP_DIRS = new Set(['node_modules', 'test', 'dist', 'coverage']);
  function sourceFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, out);
      else if (/\.(c|m)?js$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  test('no file but the card-answer handler calls the record function', () => {
    grants();
    const callers = sourceFiles(ROOT)
      .filter((file) => file !== MODULE && fs.readFileSync(file, 'utf8').includes('recordGrant('))
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
    assert.deepStrictEqual(callers, ['lib/protocol/handlers/process-control.js']);
  });
});
