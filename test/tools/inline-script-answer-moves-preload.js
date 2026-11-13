'use strict';
// Loaded with --require by inline-script-answer-moves.js, in each test process
// it runs. Every call a test makes to classifyShellAccess is answered by the
// hook as the test loaded it and by the hook at the base commit, whose source
// is in the file RUNDOCK_INLINE_MOVES_BASE names. The test is handed the first
// answer, so nothing it asserts changes. Each call whose two answers differ is
// noted, one JSON object per line, in a file of this process's own in the
// folder RUNDOCK_INLINE_MOVES names, with the count of calls beside it. Without
// that variable it does nothing.
//
// It must load before a test requires the hook, so the test is handed this
// wrapper and not the function underneath it.
const dir = process.env.RUNDOCK_INLINE_MOVES;
if (dir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { hookFromSource } = require('./inline-script-answer-moves.js');
  const hook = require('../../scripts/permission-hook.js');
  const base = hookFromSource(fs.readFileSync(process.env.RUNDOCK_INLINE_MOVES_BASE, 'utf8'));
  const out = path.join(dir, `${process.pid}.jsonl`);
  const head = hook.classifyShellAccess;
  const answer = (fn, args) => { try { return JSON.stringify(fn(...args)); } catch (e) { return `threw: ${e && e.message}`; } };
  let calls = 0;
  hook.classifyShellAccess = function (...args) {
    calls++;
    const was = answer(base.classifyShellAccess, args);
    const result = head.apply(this, args);
    const now = JSON.stringify(result);
    if (was !== now) {
      const input = args[1] || {};
      fs.appendFileSync(out, JSON.stringify({ tool: args[0], command: String(input.command || ''), base: was, head: now }) + '\n');
    }
    return result;
  };
  process.on('exit', () => fs.writeFileSync(path.join(dir, `${process.pid}.calls`), String(calls)));
}
