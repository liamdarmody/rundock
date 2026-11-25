'use strict';
// Stand-ins for the children the desktop's setup check starts
// (electron/setup-check.js), for tests that run the real check through
// main.js's own lines. Nothing is ever started: each start is recorded as one
// line, its program and arguments joined by spaces, and answered by the
// test's `answer(program, args)` as { stdout, stderr, status } on the next
// turn of the event loop. The check's own spawn is put back when the test ends.
const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const MODULE = path.join(__dirname, '..', '..', 'electron', 'setup-check.js');

// Asserted before use, so a missing module fails a test on this assertion
// rather than on a thrown require.
function loadSetupCheck() {
  let found = null;
  try { found = require.resolve(MODULE); } catch { /* asserted next */ }
  assert.ok(found, 'electron/setup-check.js is there to load');
  return require(MODULE);
}

function answerChildren(t, answer) {
  const mod = loadSetupCheck();
  const ran = [];
  const saved = mod.deps.spawn;
  mod.deps.spawn = (program, args) => {
    ran.push([program, ...args].join(' '));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    const reply = answer(program, args) || {};
    setImmediate(() => {
      if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout));
      if (reply.stderr) child.stderr.emit('data', Buffer.from(reply.stderr));
      child.emit('close', reply.status || 0, null);
    });
    return child;
  };
  t.after(() => { mod.deps.spawn = saved; });
  return ran;
}

// A Claude Code at `bin`, as `state` says at the moment each child starts:
// found unless state.found is false, started unless state.starts is false,
// and signed in only when state.signedIn is true. A failed sign-in check
// prints state.said, as Claude Code prints why.
const VERSION = '2.1.309 (Claude Code)\n';
function claudeAt(bin, state) {
  return (program, args) => {
    if (program === 'which' || program === 'where.exe') return state.found === false ? { status: 1 } : { stdout: `${bin}\n` };
    if (program !== bin) return { status: 127 };
    if (args.includes('--version')) return state.starts === false ? { status: 1 } : { stdout: VERSION };
    return state.signedIn ? { stdout: 'ok\n' } : { status: 1, stderr: state.said || '' };
  };
}

module.exports = { loadSetupCheck, answerChildren, claudeAt, VERSION };
