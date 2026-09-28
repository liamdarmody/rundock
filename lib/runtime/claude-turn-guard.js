'use strict';
// THE ANSWER-FILE GUARD AROUND CLAUDE TURNS.
//
// The permission hook reads the command a tool call carries. A write made
// inside `node -e`, `python3 -c` or a script is not a path it can see, so a
// Claude agent could change the workspace's own permission answers without a
// card. The same detect-and-restore Codex turns run under
// (lib/workspace/answer-file-guard.js) therefore runs around every Claude
// turn too: direct chats, delegates and routines, since every one of them is
// a process spawnClaude starts.
//
// A turn starts when the process starts, and again whenever a user message is
// written to it; it ends at the process's result line, or when it closes. An
// idle process waiting for its next message is not guarded, so a person
// editing these files between turns is never second-guessed.
const { acquireAnswerFileGuard } = require('../workspace/answer-file-guard.js');

const USER_MESSAGE = /"type"\s*:\s*"user"/;
const RESULT_LINE = /"type"\s*:\s*"result"/;

// Watch one Claude process. `onChange(change)` hears about each change put
// back during one of its turns. Returns { stop } for callers that end a turn
// themselves.
function watchClaudeTurns(proc, { workspace, onChange, acquire = acquireAnswerFileGuard } = {}) {
  if (!proc || !workspace) return { stop() {} };
  let guard = null;
  const start = () => { if (!guard) guard = acquire(workspace, onChange); };
  const end = () => { if (!guard) return; const g = guard; guard = null; g.release(); };

  start();
  const stdin = proc.stdin;
  if (stdin && typeof stdin.write === 'function') {
    const write = stdin.write;
    stdin.write = function (chunk, ...rest) {
      try { if (USER_MESSAGE.test(String(chunk))) start(); } catch (e) { /* never block a write */ }
      return write.call(this, chunk, ...rest);
    };
  }
  if (proc.stdout && typeof proc.stdout.on === 'function') {
    // Lines can arrive split across chunks; a short tail joins them.
    let tail = '';
    proc.stdout.on('data', (d) => {
      const text = tail + String(d);
      if (RESULT_LINE.test(text)) { end(); tail = ''; return; }
      tail = text.slice(-32);
    });
  }
  proc.on('close', end);
  return { stop: end };
}

module.exports = { watchClaudeTurns };
