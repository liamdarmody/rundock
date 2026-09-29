'use strict';
// A CLAUDE AGENT CANNOT KEEP A CHANGE TO THE WORKSPACE'S OWN PERMISSION
// ANSWERS WITHOUT ASKING, HOWEVER THE CHANGE WAS WRITTEN.
//
// The permission hook reads the command a tool call carries, so a write made
// inside `node -e` or a script never meets it. Every Claude turn therefore
// runs under the same detect-and-restore guard as a Codex turn: a change
// Rundock did not make is put back, the person is told, and asked on the
// answer-file card whether to keep it. Rundock's own writes stand.
//
// A real child process stands in for Claude here: it reads a user message on
// stdin, writes with `node -e`-style code, and prints a result line, exactly
// the shape of a stream-json Claude turn.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const config = require('../../lib/config.js');
const glue = require('../../lib/runtime/codex-glue.js');
const boundary = require('../../lib/workspace/boundary.js');
const claude = require('../../lib/runtime/claude.js');
const { watchClaudeTurns } = require('../../lib/runtime/claude-turn-guard.js');

let ws;
let prevWorkspace;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-answer-guard-'));
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.rundock', 'permissions.json'), '{"allowedTools":[]}\n');
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{"workspaceMode":"code"}\n');
  fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), '{}\n');
  prevWorkspace = config.getWorkspace();
  config.setWorkspace(ws);
});
afterEach(() => {
  if (prevWorkspace) config.setWorkspace(prevWorkspace);
  fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const read = f => fs.readFileSync(path.join(ws, f), 'utf-8');

function drivenGlue() {
  const notices = [];
  const asked = [];
  const prev = glue.wireCodexGlueDeps({
    safeSend: (s) => { const m = JSON.parse(s); if (m.subtype === 'notice') notices.push(m); },
    requestServerPermission: (req) => { asked.push(req); },
  });
  return { notices, asked, restore: () => glue.wireCodexGlueDeps(prev) };
}

// A stand-in Claude process. Each user message it reads is a snippet of code
// it runs as its turn, after which it prints a result line.
function standIn() {
  const code = `
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      try { eval(msg.message.content); } catch (e) { process.stderr.write(String(e)); }
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
    });`;
  return spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
}
function turn(proc, content) {
  return new Promise((resolve) => {
    const onData = (d) => { if (/"type":"result"/.test(String(d))) { proc.stdout.off('data', onData); setImmediate(resolve); } };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}
function guarded(proc, convoId, agentId = 'builder') {
  return watchClaudeTurns(proc, {
    workspace: ws,
    onChange: (change) => glue.surfaceAnswerFileChange({ agentId, processId: null }, convoId, change, 'claude'),
  });
}
const write = (rel, text) => `require('fs').writeFileSync(${JSON.stringify(path.join(ws, rel))}, ${JSON.stringify(text)})`;

describe('during a Claude turn, a change to an answer file made outside any tool the hook reads is put back and carded', () => {
  test('a node -e write to permissions.json is restored, the person told, and asked on the answer-file card', async () => {
    const d = drivenGlue();
    const proc = standIn();
    const before = read('.rundock/permissions.json');
    try {
      guarded(proc, 'convo-7');
      await turn(proc, write('.rundock/permissions.json', '{"allowedTools":["Bash"]}'));
    } finally { proc.kill(); d.restore(); }
    assert.strictEqual(read('.rundock/permissions.json'), before, 'back to the answers the turn started with');
    assert.strictEqual(d.notices.length, 0, 'no separate notice: the card says it all');
    assert.strictEqual(d.asked[0].convoId, 'convo-7');
    assert.deepStrictEqual(d.asked[0].grading.put_back, {
      runtime: 'claude', outsideTurn: false, relative: '.rundock/permissions.json',
      before: '{"allowedTools":[]}\n', after: '{"allowedTools":["Bash"]}',
    });
    assert.strictEqual(d.asked.length, 1);
    assert.strictEqual(d.asked[0].grading.answer_file, true);
    assert.strictEqual(d.asked[0].grading.grant_dir, null, 'never remembered');
    assert.strictEqual(d.asked[0].toolInput.content, '{"allowedTools":["Bash"]}', 'the card carries what the agent wrote');
  });

  test('all four files are covered, settings.json included', async () => {
    const d = drivenGlue();
    const proc = standIn();
    const files = ['.rundock/permissions.json', '.rundock/state.json', '.claude/settings.local.json', '.claude/settings.json'];
    const before = Object.fromEntries(files.map(f => [f, read(f)]));
    try {
      guarded(proc, 'convo-7');
      await turn(proc, files.map(f => write(f, 'planted')).join(';'));
    } finally { proc.kill(); d.restore(); }
    for (const f of files) assert.strictEqual(read(f), before[f], f);
    assert.strictEqual(d.asked.length, 4);
  });

  test('approving the card keeps the agent\'s version', async () => {
    const d = drivenGlue();
    const proc = standIn();
    try {
      guarded(proc, 'convo-7');
      await turn(proc, write('.claude/settings.local.json', '{"kept":true}'));
      d.asked[0].onDecision(true);
    } finally { proc.kill(); d.restore(); }
    assert.strictEqual(read('.claude/settings.local.json'), '{"kept":true}');
  });
});

describe('the agent is told when its change is put back', () => {
  const notices = require('../../lib/runtime/agent-notices.js');
  test('a change put back during a turn leaves the agent a line for its next tool call', async () => {
    notices.takeAgentNotice('convo-7'); // lines left by earlier tests in this file
    const d = drivenGlue();
    const proc = standIn();
    try {
      guarded(proc, 'convo-7');
      await turn(proc, write('.rundock/permissions.json', '{"allowedTools":["Bash"]}'));
    } finally { proc.kill(); d.restore(); }
    assert.strictEqual(notices.takeAgentNotice('convo-7'),
      'Rundock put back your change to .rundock/permissions.json because it holds the person\'s permission answers. '
      + 'They are being asked whether to keep it; don\'t try the change another way.');
  });

  test('a change caught between turns leaves no line: no agent is known to have made it', async () => {
    notices.takeAgentNotice('convo-7'); // lines left by earlier tests in this file
    const d = drivenGlue();
    const proc = standIn();
    try {
      guarded(proc, 'convo-7');
      await turn(proc, '1 + 1');
      fs.writeFileSync(path.join(ws, '.rundock', 'permissions.json'), '{"allowedTools":["Bash"]}\n');
      await turn(proc, '1 + 1');
    } finally { proc.kill(); d.restore(); }
    assert.strictEqual(notices.takeAgentNotice('convo-7'), null);
  });
});

describe('Rundock\'s own writes during a Claude turn stand', () => {
  test('a standing allow stored through the product mid-turn is not reverted', async () => {
    const d = drivenGlue();
    const proc = standIn();
    try {
      guarded(proc, 'convo-7');
      boundary.addToolAllow('Bash:npm');
      await turn(proc, '1 + 1');
    } finally { proc.kill(); d.restore(); }
    assert.match(read('.rundock/permissions.json'), /Bash:npm/);
    assert.strictEqual(d.notices.length, 0);
  });
});

describe('a change made between turns is caught when the next turn starts', () => {
  test('a background job that outlives its turn and then writes permissions.json is restored and carded at the next turn', async () => {
    const d = drivenGlue();
    const proc = standIn();
    const f = path.join(ws, '.rundock', 'permissions.json');
    const before = read('.rundock/permissions.json');
    try {
      guarded(proc, 'convo-7');
      // The turn starts a job that writes after the turn has ended.
      const job = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(f)}, '{"allowedTools":["Bash:*"]}'), 300)`)}], { detached: true, stdio: 'ignore' }).unref()`;
      await turn(proc, job);
      await new Promise(r => setTimeout(r, 700));
      assert.match(read('.rundock/permissions.json'), /Bash:\*/, 'written while no turn was running');
      await turn(proc, '1 + 1');
    } finally { proc.kill(); d.restore(); }
    assert.strictEqual(read('.rundock/permissions.json'), before, 'put back when the next turn started');
    assert.strictEqual(d.notices.length, 0);
    assert.strictEqual(d.asked[0].grading.put_back.outsideTurn, true);
    assert.strictEqual(d.asked.length, 1);
  });

  test('a person editing the Claude Code settings between turns keeps the edit, with no notice and no card', async () => {
    const d = drivenGlue();
    const proc = standIn();
    try {
      guarded(proc, 'convo-7');
      await turn(proc, '1 + 1');
      fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), '{"edited":"by the person"}\n');
      await new Promise(r => setTimeout(r, 400));
      await turn(proc, '1 + 1');
    } finally { proc.kill(); d.restore(); }
    assert.strictEqual(read('.claude/settings.json'), '{"edited":"by the person"}\n', 'kept');
    assert.strictEqual(d.asked.length, 0);
    assert.strictEqual(d.notices.length, 0);
  });

  test('a person editing Rundock\'s own permission file between turns is asked at the next turn', async () => {
    const d = drivenGlue();
    const proc = standIn();
    try {
      guarded(proc, 'convo-7');
      await turn(proc, '1 + 1');
      fs.writeFileSync(path.join(ws, '.rundock', 'permissions.json'), '{"allowedTools":["Bash"]}\n');
      await turn(proc, '1 + 1');
      assert.strictEqual(d.asked.length, 1, 'the next turn asks');
      d.asked[0].onDecision(true);
    } finally { proc.kill(); d.restore(); }
    assert.strictEqual(read('.rundock/permissions.json'), '{"allowedTools":["Bash"]}\n', 'and keeping it keeps it');
  });
});

describe('every Claude process is guarded', () => {
  test('spawnClaude hands every process, with its conversation and agent, to the guard', () => {
    const seen = [];
    const prev = claude.wireClaudeRuntimeDeps({ onClaudeSpawn: (proc, info) => seen.push(info) });
    let proc;
    try {
      proc = claude.spawnClaude(['--version', '--agent', 'builder'], {
        cwd: ws, env: { ...process.env, RUNDOCK_CONVO_ID: 'convo-9' }, stdio: 'ignore',
      });
    } finally { claude.wireClaudeRuntimeDeps(prev); }
    try { proc.kill(); } catch (e) { /* already gone */ }
    assert.deepStrictEqual(seen, [{ convoId: 'convo-9', agentId: 'builder' }]);
  });

  test('the server wires the guard, with the Claude notice', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    const i = src.indexOf('onClaudeSpawn:');
    assert.ok(i >= 0, 'the server wires onClaudeSpawn');
    const wiring = src.slice(i, i + 400);
    assert.match(wiring, /watchClaudeTurns\(proc/);
    assert.match(wiring, /surfaceAnswerFileChange\([^)]*'claude'\)/);
  });
});
