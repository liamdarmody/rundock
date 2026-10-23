'use strict';
// A CHANGE A PERSON ALLOWED ON THE HOOK'S CARD STANDS, AND IS ASKED ABOUT ONCE.
//
// The permission hook asks before a Claude agent writes a file that decides
// what runs or holds the person's answers. The detect-and-restore guard then
// saw the write that was allowed as a change nobody made: it was put back,
// the agent was told so, and a second card asked whether to keep it. An Allow
// on the hook's card now marks the path for the conversation it was given in,
// with the content the card showed where the tool names it, and the guard
// takes the next matching change by that conversation as the new starting
// point, once. Anything else is still put back.
//
// Driven through the server's own answer handler and the Claude turn watcher,
// against a workspace in the temp folder, so it needs no fixture.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const config = require('../../lib/config.js');
const glue = require('../../lib/runtime/codex-glue.js');
const notices = require('../../lib/runtime/agent-notices.js');
const { watchClaudeTurns } = require('../../lib/runtime/claude-turn-guard.js');
const { handlePermissionResponse } = require('../../lib/protocol/handlers/process-control.js');
const { checkAnswerFilesNow } = require('../../lib/workspace/answer-file-guard.js');

const ORIGINAL = '{"mcpServers":{}}\n';
let ws, mcp, prevWorkspace, seq = 0;
beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'allowed-change-')));
  fs.mkdirSync(path.join(ws, '.rundock'));
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{}\n');
  mcp = path.join(ws, '.mcp.json');
  fs.writeFileSync(mcp, ORIGINAL);
  prevWorkspace = config.getWorkspace();
  config.setWorkspace(ws);
});
afterEach(() => {
  if (prevWorkspace) config.setWorkspace(prevWorkspace);
  fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

// One Claude process, its turns guarded the way the server guards them.
function claudeTurn(convoId) {
  const proc = new EventEmitter();
  proc.stdin = { write: () => true };
  proc.stdout = new EventEmitter();
  const asked = [];
  const prev = glue.wireCodexGlueDeps({ safeSend: () => {}, requestServerPermission: (req) => { asked.push(req); } });
  watchClaudeTurns(proc, {
    workspace: ws, convoId,
    onChange: (change) => glue.surfaceAnswerFileChange({ agentId: 'builder', processId: null }, convoId, change, 'claude'),
  });
  return {
    asked,
    nextTurn: () => proc.stdin.write('{"type":"user","message":{}}\n'),
    endTurn: () => proc.stdout.emit('data', '{"type":"result"}\n'),
    done: () => { proc.emit('close'); glue.wireCodexGlueDeps(prev); },
  };
}

// The person answers the hook's card in the browser.
function answer(pending, allow = true) {
  const requestId = `perm-test-${++seq}`;
  const res = { writeHead() {}, end(body) { res.body = body; } };
  const ctx = { pendingPermissions: new Map([[requestId, { ...pending, res, timer: null }]]), broadcast: () => {} };
  handlePermissionResponse(ctx, { send() {} }, { requestId, allow, card: true, conversationId: pending.conversationId });
  return JSON.parse(res.body);
}
const writeCard = (convoId, content) => ({
  conversationId: convoId, toolName: 'Write', toolInput: { file_path: mcp, content }, answerFile: true, resolvedPath: mcp,
});

describe('an Allow on the hook card', () => {
  test('a Write allowed on the card stands: no second card, and the agent is not told it was put back', () => {
    const NEW = '{"mcpServers":{"docs":{"url":"https://example.com/mcp"}}}\n';
    const t = claudeTurn('c-write');
    try {
      assert.strictEqual(answer(writeCard('c-write', NEW)).allow, true);
      fs.writeFileSync(mcp, NEW);
      t.endTurn();
    } finally { t.done(); }
    assert.strictEqual(fs.readFileSync(mcp, 'utf-8'), NEW, 'the allowed write stands');
    assert.strictEqual(t.asked.length, 0, 'no second card');
    assert.strictEqual(notices.takeAgentNotice('c-write'), null, 'the agent is not told it was put back');
  });

  test('an Edit allowed on the card stands, worked out against the file as it stood', () => {
    const t = claudeTurn('c-edit');
    try {
      answer({ conversationId: 'c-edit', toolName: 'Edit', toolInput: { file_path: mcp, old_string: '{}', new_string: '{"a":{}}' }, answerFile: true, resolvedPath: mcp });
      fs.writeFileSync(mcp, ORIGINAL.replace('{}', '{"a":{}}'));
      t.endTurn();
    } finally { t.done(); }
    assert.strictEqual(fs.readFileSync(mcp, 'utf-8'), '{"mcpServers":{"a":{}}}\n');
    assert.strictEqual(t.asked.length, 0);
  });

  test('a shell command allowed on the card covers the change it makes to the files it named', () => {
    const t = claudeTurn('c-shell');
    try {
      answer({ conversationId: 'c-shell', toolName: 'Bash', toolInput: { command: 'echo {} > .mcp.json' }, boundary: true, crossings: [{ path: mcp, answerFile: true }] });
      fs.writeFileSync(mcp, '{}\n');
      t.endTurn();
    } finally { t.done(); }
    assert.strictEqual(fs.readFileSync(mcp, 'utf-8'), '{}\n');
    assert.strictEqual(t.asked.length, 0);
  });
});

describe('the wiring', () => {
  test('the server hands each Claude process\'s conversation to its guard', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    const i = src.indexOf('onClaudeSpawn:');
    assert.ok(i >= 0);
    const wiring = src.slice(i, src.indexOf('}),', i));
    assert.match(wiring, /watchClaudeTurns\(proc, \{[^}]*\bconvoId,/);
  });
});

describe('what an Allow does not cover is still put back', () => {
  test('a write the person denied', () => {
    const t = claudeTurn('c-deny');
    try {
      answer(writeCard('c-deny', 'denied'), false);
      fs.writeFileSync(mcp, 'denied');
      t.endTurn();
    } finally { t.done(); }
    assert.strictEqual(fs.readFileSync(mcp, 'utf-8'), ORIGINAL);
    assert.strictEqual(t.asked.length, 1, 'offered on the put-back card');
    assert.match(notices.takeAgentNotice('c-deny') || '', /put back your change to \.mcp\.json/, 'and the agent is told');
  });

  test('content other than the card showed, written another way', () => {
    const t = claudeTurn('c-other');
    try {
      answer(writeCard('c-other', 'what the card showed'));
      fs.writeFileSync(mcp, 'something else');
      t.endTurn();
    } finally { t.done(); }
    assert.strictEqual(fs.readFileSync(mcp, 'utf-8'), ORIGINAL);
    assert.strictEqual(t.asked.length, 1);
  });

  test('a change made during another conversation\'s turn', () => {
    const t = claudeTurn('c-mine');
    try {
      answer(writeCard('c-someone-else', 'theirs'));
      fs.writeFileSync(mcp, 'theirs');
      t.endTurn();
    } finally { t.done(); }
    assert.strictEqual(fs.readFileSync(mcp, 'utf-8'), ORIGINAL);
    assert.strictEqual(t.asked.length, 1);
  });

  test('a second change after the allowed one, in the same turn: an allow is used once', () => {
    const t = claudeTurn('c-twice');
    try {
      answer({ conversationId: 'c-twice', toolName: 'Bash', toolInput: { command: 'x' }, boundary: true, crossings: [{ path: mcp, answerFile: true }] });
      fs.writeFileSync(mcp, 'first');
      // The check the finished tool call asks for (the PostToolUse hook).
      checkAnswerFilesNow(ws);
      fs.writeFileSync(mcp, 'second');
      t.endTurn();
    } finally { t.done(); }
    assert.strictEqual(fs.readFileSync(mcp, 'utf-8'), 'first', 'the allowed change stood, the next was put back');
    assert.strictEqual(t.asked.length, 1);
  });

  // A SHELL COMMAND NAMES NO CONTENT, so its mark covers only that command:
  // it goes at the check made as that command finishes. A later write in the
  // same turn, by whatever means, is put back.
  test('a shell allow covers its own command only: a write after that command finished is put back', () => {
    const t = claudeTurn('c-later');
    try {
      answer({ conversationId: 'c-later', toolName: 'Bash', toolInput: { command: 'cat .mcp.json > /dev/null' }, boundary: true, crossings: [{ path: mcp, answerFile: true }] });
      // The allowed command finished without writing; its finished-call check.
      checkAnswerFilesNow(ws, { finishedFor: 'c-later' });
      fs.writeFileSync(mcp, 'written later');
      t.endTurn();
    } finally { t.done(); }
    assert.strictEqual(fs.readFileSync(mcp, 'utf-8'), ORIGINAL, 'the later write is put back');
    assert.strictEqual(t.asked.length, 1, 'and offered on the card');
  });

  test('the finished-call check of another conversation leaves a shell allow alone', () => {
    const t = claudeTurn('c-mine-2');
    try {
      answer({ conversationId: 'c-mine-2', toolName: 'Bash', toolInput: { command: 'x' }, boundary: true, crossings: [{ path: mcp, answerFile: true }] });
      checkAnswerFilesNow(ws, { finishedFor: 'c-someone-else' });
      fs.writeFileSync(mcp, 'mine');
      checkAnswerFilesNow(ws, { finishedFor: 'c-mine-2' });
      t.endTurn();
    } finally { t.done(); }
    assert.strictEqual(fs.readFileSync(mcp, 'utf-8'), 'mine');
    assert.strictEqual(t.asked.length, 0);
  });

  test('the server drops a shell allow at the conversation\'s finished-call check', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'http-router.js'), 'utf8');
    assert.match(src, /checkAnswerFilesNow\(getWorkspace\(\), \{ finishedFor: id \|\| null \}\)/);
  });

  test('an allow nothing used ends with the turn it was given in', () => {
    const t = claudeTurn('c-unused');
    try {
      answer(writeCard('c-unused', 'later'));
      t.endTurn();
      t.nextTurn();
      fs.writeFileSync(mcp, 'later');
      t.endTurn();
    } finally { t.done(); }
    assert.strictEqual(fs.readFileSync(mcp, 'utf-8'), ORIGINAL);
    assert.strictEqual(t.asked.length, 1);
  });
});
