'use strict';
// A CODEX AGENT CANNOT KEEP A CHANGE TO THE FILES THAT DECIDE WHAT RUNS.
//
// Codex runs with workspace-write, so its writes inside the workspace never
// escalate and never meet a card: the detect-and-restore guard
// (lib/workspace/answer-file-guard.js) is what stands in front of them. It now
// watches the launcher the runtime starts the permission hook through,
// `.mcp.json`, the per-user connector file, and the hook scripts present under
// `.claude/hooks/` when the guard starts, beside the files that hold the
// person's permission answers. A change Rundock did not make during a turn is
// put back at once and offered on the put-back card.
//
// `.mcp.json`, the per-user connector file and the hook scripts are also edited
// by hand and by git, so a change found between turns is taken as the new
// starting point, like the Claude Code settings files. The launcher is
// Rundock's alone: Rundock writes it, recording that it did.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const guardLib = require('../../lib/workspace/answer-file-guard.js');
const config = require('../../lib/config.js');
const glue = require('../../lib/runtime/codex-glue.js');
const RP = require('../../public/permissions.js');

const FILES = ['.rundock/permission-hook.sh', '.rundock/permission-hook.cmd', '.mcp.json', '.rundock/mcp-secrets.json',
  '.claude/hooks/pre-tool.sh', '.claude/hooks/lib/notify.py'];
let ws;
let prevWorkspace;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'what-runs-guard-'));
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), `original ${f}\n`);
  }
  fs.chmodSync(path.join(ws, '.rundock', 'permission-hook.sh'), 0o755);
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{}\n');
  prevWorkspace = config.getWorkspace();
  config.setWorkspace(ws);
});
afterEach(() => {
  if (prevWorkspace) config.setWorkspace(prevWorkspace);
  fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const read = f => fs.readFileSync(path.join(ws, f), 'utf-8');
function asFileEdit(f, text) { fs.appendFileSync(path.join(ws, f), text); }
function asShellRedirect(f, text) { execFileSync('sh', ['-c', `printf '%s' '${text}' >> '${path.join(ws, f)}'`]); }
function drivenGlue() {
  const asked = [];
  const prev = glue.wireCodexGlueDeps({ safeSend: () => {}, requestServerPermission: (req) => { asked.push(req); } });
  return { asked, restore: () => glue.wireCodexGlueDeps(prev) };
}

describe('during a Codex turn, a change to a file that decides what runs is put back and reported', () => {
  for (const [route, write] of [['file edit', asFileEdit], ['shell redirect', asShellRedirect]]) {
    test(`each file, by ${route}`, () => {
      const before = Object.fromEntries(FILES.map(f => [f, read(f)]));
      const d = drivenGlue();
      const entry = { agentId: 'builder', processId: 'p1' };
      try {
        glue.guardCodexTurn(entry, 'convo-1');
        for (const f of FILES) write(f, 'planted');
        glue.releaseCodexTurnGuard(entry);
      } finally { d.restore(); }
      for (const f of FILES) assert.strictEqual(read(f), before[f], `${f} is back to what it was when the turn started`);
      assert.strictEqual(fs.statSync(path.join(ws, '.rundock', 'permission-hook.sh')).mode & 0o777, 0o755, 'the launcher keeps its mode');
      assert.deepStrictEqual(d.asked.map(r => r.grading.put_back.relative).sort(), [...FILES].sort(), 'one put-back card for each');
      for (const req of d.asked) {
        assert.strictEqual(req.grading.answer_file, true);
        assert.strictEqual(req.grading.grant_dir, null);
        assert.match(req.grading.put_back.after, /planted$/);
      }
    });
  }

  test('a removed hook script is put back', () => {
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      fs.rmSync(path.join(ws, '.claude', 'hooks', 'pre-tool.sh'));
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    assert.strictEqual(read('.claude/hooks/pre-tool.sh'), 'original .claude/hooks/pre-tool.sh\n');
  });

  test('the card and the agent are told what the file decides, not that it holds permission answers', () => {
    const launcher = RP.putBackCardCopy({ runtime: 'codex', relative: '.rundock/permission-hook.sh' });
    assert.strictEqual(launcher.heading, 'Rundock put back a change to its permission checks');
    assert.match(launcher.body, /the file that starts Rundock's permission checks/);
    for (const relative of ['.mcp.json', '.rundock/mcp-secrets.json', '.claude/hooks/pre-tool.sh']) {
      const c = RP.putBackCardCopy({ runtime: 'codex', relative });
      assert.strictEqual(c.heading, 'Rundock put back a change to what runs', relative);
      assert.match(c.body, /a file that decides what Rundock or Claude Code runs/, relative);
      assert.match(glue.agentRestoreNotice(relative), /because it decides what runs/, relative);
    }
    assert.match(glue.agentRestoreNotice('.rundock/permission-hook.sh'), /because it starts the permission checks/);
    assert.strictEqual(RP.putBackCardCopy({ runtime: 'codex', relative: '.rundock/permissions.json' }).heading,
      'Rundock put back a change to your permission answers', 'the answer files keep their own words');
  });
});

describe('between turns', () => {
  test('a change to .mcp.json, the per-user connector file or a hook script, made outside Rundock, becomes the starting point', () => {
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      glue.releaseCodexTurnGuard(entry);
      for (const f of ['.mcp.json', '.rundock/mcp-secrets.json', '.claude/hooks/pre-tool.sh']) asFileEdit(f, 'by hand');
      glue.guardCodexTurn(entry, 'convo-1');
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    for (const f of ['.mcp.json', '.rundock/mcp-secrets.json', '.claude/hooks/pre-tool.sh']) assert.match(read(f), /by hand$/, `${f} is left as the person made it`);
    assert.strictEqual(d.asked.length, 0, 'and nobody is asked');
  });

  test('a change to the launcher is put back and asked about, since only Rundock writes it', () => {
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      glue.releaseCodexTurnGuard(entry);
      asFileEdit('.rundock/permission-hook.sh', 'left behind');
      glue.guardCodexTurn(entry, 'convo-1');
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    assert.strictEqual(read('.rundock/permission-hook.sh'), 'original .rundock/permission-hook.sh\n');
    assert.strictEqual(d.asked.length, 1);
    assert.strictEqual(d.asked[0].grading.put_back.outsideTurn, true);
  });
});

describe('Rundock\'s own writes of these files stand', () => {
  test('the launcher written on open, and a connector the person allowed, during a turn', () => {
    const scaffold = require('../../lib/workspace/scaffold.js');
    const team = require('../../lib/protocol/handlers/team.js');
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    const sent = [];
    const ctx = {
      workspace: { isInsideWorkspace: () => true }, agents: { validateAgentSlug: () => true },
      runtime: { requestServerPermission: ({ onDecision }) => onDecision(true, 'user', { card: true }) },
    };
    const prevDeps = scaffold.wireScaffoldDeps({ invalidateAgentCache: () => {}, rebaselineAgentsWatcher: () => {} });
    fs.writeFileSync(path.join(ws, '.mcp.json'), '{"mcpServers":{}}');
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      scaffold.scaffoldWorkspace(ws, { platform: 'darwin' });
      team.handleSaveConnector(ctx, { send: (m) => sent.push(JSON.parse(m)) }, { name: 'docs', content: '{"url":"https://example.com/mcp"}' });
      glue.releaseCodexTurnGuard(entry);
    } finally { scaffold.wireScaffoldDeps(prevDeps); d.restore(); }
    assert.match(read('.rundock/permission-hook.sh'), /permission-hook\.js/, 'the launcher Rundock wrote is still there');
    assert.deepStrictEqual(JSON.parse(read('.mcp.json')).mcpServers.docs, { url: 'https://example.com/mcp' }, 'and so is the connector it wrote');
    assert.deepStrictEqual(d.asked.map(r => r.grading.put_back.relative).filter(r => r === '.mcp.json' || r.startsWith('.rundock/permission-hook')), [],
      'neither is put back as somebody else\'s change');
  });
});

describe('the guard is the hook\'s registry', () => {
  test('every answer file the hook names is watched', () => {
    const hook = require('../../scripts/permission-hook.js');
    for (const f of hook.WORKSPACE_ANSWER_FILES) assert.ok(guardLib.ANSWER_FILES.includes(f), `${f} is watched`);
  });
});
