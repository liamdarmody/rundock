'use strict';
// ONLY THE SCHEDULER STARTS AN AGENT WITH NO CONVERSATION.
//
// A refused card is worded by who can be asked, and the permission hook tells
// the two apart by one thing: whether the agent was started with a
// conversation (RUNDOCK_CONVO_ID). A routine's agent is started with none, so
// it is told to carry on or to say it failed; a conversation's, a delegated
// agent's included, is told to stop and ask. The words themselves, and the
// real hook giving each, are in unattended-refusal.test.js.
//
// Read from the source, and cheap on purpose: a new spawn that passes no
// conversation, or a second environment marked as Rundock's, fails here
// before anything runs, rather than telling a conversation's agent it has
// nobody to ask.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// ── Which spawns name no conversation ──
//
// Absence is the mark, so a spawn that forgot its conversation would be told
// it has nobody to ask. Every production call of getSpawnEnv is listed here
// with what it passes: a conversation spawn passes its conversation id, and
// the scheduler's routine spawn passes none. The one other environment that
// marks a process as Rundock's (the shared Codex app-server) names no
// conversation either, and never runs this hook: Codex refusals are told
// through codex-glue, in a conversation's words, and a Codex routine runs with
// no approvals to refuse.
describe('only the scheduler starts an agent with no conversation', () => {
  const sources = () => {
    const out = [path.join(ROOT, 'server.js')];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) out.push(p);
      }
    };
    walk(path.join(ROOT, 'lib'));
    return out;
  };
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

  test('every getSpawnEnv call passes a conversation, except the routine spawn', () => {
    const calls = [];
    for (const file of sources()) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/getSpawnEnv\(([^)]*)\)/g)) {
        if (/function getSpawnEnv\(/.test(text.slice(Math.max(0, m.index - 9), m.index + 12))) continue;
        calls.push(`${rel(file)}: ${m[1]}`);
      }
    }
    const routine = calls.filter((c) => !c.endsWith(': convoId'));
    assert.deepStrictEqual(routine, ['lib/scheduler.js: null'], `calls found:\n${calls.join('\n')}`);
    assert.ok(calls.length >= 8, `every conversation spawn is listed: ${calls.length}`);
  });

  test('a conversation spawn never has an empty conversation to pass', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(server, /const convoId = msg\.conversationId \|\| 'default';/, 'a chat with no id is the default conversation');
  });

  test('the only other environment marked as Rundock\'s is the Codex app-server\'s, which names no conversation', () => {
    const marked = sources().filter((f) => /RUNDOCK: '1'/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
    assert.deepStrictEqual(marked, ['lib/runtime/claude.js', 'lib/runtime/codex-glue.js']);
  });
});
