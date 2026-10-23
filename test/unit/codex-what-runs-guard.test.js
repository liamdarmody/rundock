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
const LAUNCHERS = ['.rundock/permission-hook.sh', '.rundock/permission-hook.cmd'];
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
  const notices = [];
  const prev = glue.wireCodexGlueDeps({
    safeSend: (s) => { const m = JSON.parse(s); if (m.subtype === 'notice') notices.push(m); },
    requestServerPermission: (req) => { asked.push(req); },
  });
  return { asked, notices, restore: () => glue.wireCodexGlueDeps(prev) };
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
      assert.deepStrictEqual(d.asked.map(r => r.grading.put_back.relative).sort(), FILES.filter(f => !LAUNCHERS.includes(f)).sort(),
        'one put-back card for each, and none for the launchers, which are put back without one');
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
  // Taken as the starting point, which is also the one way a late write by an
  // agent's background job can stand, so the person is told which file, in a
  // quiet notice rather than a card.
  test('a change to .mcp.json, the per-user connector file or a hook script, made outside Rundock, becomes the starting point, said in a notice', () => {
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    const changed = ['.mcp.json', '.rundock/mcp-secrets.json', '.claude/hooks/pre-tool.sh'];
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      glue.releaseCodexTurnGuard(entry);
      for (const f of changed) asFileEdit(f, 'by hand');
      glue.guardCodexTurn(entry, 'convo-1');
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    for (const f of changed) assert.match(read(f), /by hand$/, `${f} is left as the person made it`);
    assert.strictEqual(d.asked.length, 0, 'and nobody is asked');
    assert.strictEqual(d.notices.length, changed.length, 'one notice for each');
    for (const f of changed) {
      const n = d.notices.find(m => m.content.startsWith(`${f} changed while no agent was running`));
      assert.ok(n, `the notice names ${f}`);
      assert.match(n.content, /kept it as it is\. It decides what runs/);
      assert.strictEqual(n._conversationId, 'convo-1', 'in the conversation whose turn found it');
    }
  });

  test('the first turn in a workspace says nothing about the files already there', () => {
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    assert.deepStrictEqual(d.notices, []);
    assert.deepStrictEqual(d.asked, []);
  });

  test('a change to the launcher is put back, since only Rundock writes it', () => {
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
    assert.strictEqual(d.asked.length, 0, 'with no card: there is nothing a person could choose to keep');
  });
});

// THE LAUNCHER IS THIS RUNDOCK'S OWN. Two copies of Rundock open on one
// workspace (an installed app and one run from source, say) each write their
// own launcher, and each took the other's as a change to put back and offer
// on a card, every time. Whoever changed it, the launcher is put back to the
// one this copy wrote, with no card and no line to the agent.
describe('the launcher, with another copy of Rundock on the same workspace', () => {
  const launcher = () => path.join(ws, '.rundock', 'permission-hook.sh');
  const MINE = '#!/bin/sh\nexec "/this/copy" "$@"\n';
  const THEIRS = '#!/bin/sh\nexec "/the/other/copy" "$@"\n';

  test('the other copy\'s launcher, written during a turn, is replaced by this copy\'s own, silently', () => {
    fs.writeFileSync(launcher(), MINE);
    guardLib.noteOwnWrite(launcher(), MINE);
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    try {
      glue.guardCodexTurn(entry, 'convo-2');
      fs.writeFileSync(launcher(), THEIRS);
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    assert.strictEqual(fs.readFileSync(launcher(), 'utf-8'), MINE);
    assert.strictEqual(fs.statSync(launcher()).mode & 0o777, 0o755, 'still runnable');
    assert.strictEqual(d.asked.length, 0, 'no card');
    assert.strictEqual(glue.withAgentNotice('convo-2', 'next'), 'next', 'and nothing said to the agent');
  });

  test('the launcher this copy wrote last is the one put back, when the other copy\'s lands before the next check', () => {
    fs.writeFileSync(launcher(), MINE);
    guardLib.noteOwnWrite(launcher(), MINE);
    const REWRITTEN = '#!/bin/sh\nexec "/this/copy/updated" "$@"\n';
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    try {
      glue.guardCodexTurn(entry, 'convo-4');
      // This copy writes a new launcher, and the other's lands on top of it
      // before any check has seen this one.
      guardLib.noteOwnWrite(launcher(), REWRITTEN);
      fs.writeFileSync(launcher(), THEIRS);
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    assert.strictEqual(fs.readFileSync(launcher(), 'utf-8'), REWRITTEN);
    assert.strictEqual(d.asked.length, 0);
  });

  test('one already there when the guard first starts is replaced too', () => {
    guardLib.noteOwnWrite(launcher(), MINE);
    fs.writeFileSync(launcher(), THEIRS);
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    try {
      glue.guardCodexTurn(entry, 'convo-3');
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    assert.strictEqual(fs.readFileSync(launcher(), 'utf-8'), MINE);
    assert.strictEqual(d.asked.length, 0);
  });
});

// A HOOK SCRIPT THAT WAS NOT THERE WHEN THE BASELINE WAS TAKEN is a change from
// nothing. The folder is listed at every check, so a script added during a
// turn is removed and offered on the card, and one a person adds between turns
// is the starting point for the next.
describe('a hook script that was not there before', () => {
  test('one an agent adds during a turn is removed and offered on the card, nested ones included', () => {
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      fs.writeFileSync(path.join(ws, '.claude', 'hooks', 'new.sh'), 'planted');
      fs.mkdirSync(path.join(ws, '.claude', 'hooks', 'more'));
      fs.writeFileSync(path.join(ws, '.claude', 'hooks', 'more', 'deep.py'), 'planted');
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    assert.ok(!fs.existsSync(path.join(ws, '.claude', 'hooks', 'new.sh')), 'the new script is gone');
    assert.ok(!fs.existsSync(path.join(ws, '.claude', 'hooks', 'more', 'deep.py')), 'and so is the nested one');
    assert.deepStrictEqual(d.asked.map(r => r.grading.put_back.relative).sort(), ['.claude/hooks/more/deep.py', '.claude/hooks/new.sh']);
    for (const r of d.asked) {
      assert.strictEqual(r.grading.put_back.before, null, 'shown as a file that did not exist');
      assert.strictEqual(r.grading.put_back.after, 'planted');
    }
  });

  test('one added in a hooks folder that did not exist when the turn started', () => {
    fs.rmSync(path.join(ws, '.claude', 'hooks'), { recursive: true });
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      fs.mkdirSync(path.join(ws, '.claude', 'hooks'));
      fs.writeFileSync(path.join(ws, '.claude', 'hooks', 'first.sh'), 'planted');
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    assert.ok(!fs.existsSync(path.join(ws, '.claude', 'hooks', 'first.sh')));
    assert.deepStrictEqual(d.asked.map(r => r.grading.put_back.relative), ['.claude/hooks/first.sh']);
  });

  test('one a person adds between turns is the starting point for the next turn', () => {
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    const added = path.join(ws, '.claude', 'hooks', 'added.sh');
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      glue.releaseCodexTurnGuard(entry);
      fs.writeFileSync(added, 'by hand');
      glue.guardCodexTurn(entry, 'convo-1');
      assert.strictEqual(fs.readFileSync(added, 'utf-8'), 'by hand', 'left as the person made it');
      assert.ok(d.notices.some(m => m.content.startsWith('.claude/hooks/added.sh changed while no agent was running')), 'and named in a notice');
      fs.appendFileSync(added, ' planted');
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    assert.strictEqual(fs.readFileSync(added, 'utf-8'), 'by hand', 'an agent\'s change to it is put back to the person\'s version');
    assert.deepStrictEqual(d.asked.map(r => [r.grading.put_back.relative, r.grading.put_back.before]), [['.claude/hooks/added.sh', 'by hand']]);
  });

  test('a hooks folder swapped for a link is not listed, so nothing where it points is removed', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'what-runs-outside-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'not the workspace\'s');
    // An empty hooks folder, so no script of its own is put back first.
    fs.rmSync(path.join(ws, '.claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.claude', 'hooks'));
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      fs.rmSync(path.join(ws, '.claude', 'hooks'), { recursive: true });
      fs.symlinkSync(outside, path.join(ws, '.claude', 'hooks'));
      glue.releaseCodexTurnGuard(entry);
      assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf-8'), 'not the workspace\'s');
      assert.ok(!d.asked.some(r => r.grading.put_back.relative === '.claude/hooks/keep.txt'), 'not taken for a new script');
    } finally { d.restore(); fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

// A FOLDER ON THE WAY SWAPPED FOR A LINK. Reading through it, the watched files
// look changed, and putting them back through it would overwrite or remove
// files wherever it points: `.claude` linked to the runtime's own folder would
// have its settings replaced, or removed when the workspace had none. The link
// is taken away first, or the person's own link put back, and only then are
// the files restored, inside the workspace.
describe('a folder on the way swapped for a link', () => {
  let outside;
  beforeEach(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'what-runs-outside-'));
    fs.mkdirSync(path.join(outside, 'hooks'));
    fs.writeFileSync(path.join(outside, 'settings.json'), 'theirs');
    fs.writeFileSync(path.join(outside, 'hooks', 'pre-tool.sh'), 'theirs');
  });
  afterEach(() => { fs.rmSync(outside, { recursive: true, force: true }); });
  const untouched = () => {
    assert.strictEqual(fs.readFileSync(path.join(outside, 'settings.json'), 'utf-8'), 'theirs', 'nothing where the link points is overwritten or removed');
    assert.strictEqual(fs.readFileSync(path.join(outside, 'hooks', 'pre-tool.sh'), 'utf-8'), 'theirs');
  };

  test('.claude swapped for a link: nothing where it points is changed, and the files are back inside the workspace', () => {
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      fs.renameSync(path.join(ws, '.claude'), path.join(ws, 'moved'));
      fs.symlinkSync(outside, path.join(ws, '.claude'));
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    untouched();
    assert.ok(fs.lstatSync(path.join(ws, '.claude')).isDirectory(), '.claude is a folder in the workspace again');
    assert.strictEqual(read('.claude/hooks/pre-tool.sh'), 'original .claude/hooks/pre-tool.sh\n');
    assert.ok(!fs.existsSync(path.join(ws, '.claude', 'settings.json')), 'a file that was not there is still not there');
  });

  test('the person\'s own link stays, and one pointed somewhere else is pointed back', () => {
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'what-runs-mine-'));
    try {
      fs.renameSync(path.join(ws, '.claude'), path.join(mine, 'claude'));
      fs.writeFileSync(path.join(mine, 'claude', 'settings.json'), 'mine');
      fs.symlinkSync(path.join(mine, 'claude'), path.join(ws, '.claude'));
      const d = drivenGlue();
      const entry = { agentId: 'builder', processId: 'p1' };
      try {
        glue.guardCodexTurn(entry, 'convo-1');
        fs.appendFileSync(path.join(ws, '.claude', 'settings.json'), ' planted');
        glue.releaseCodexTurnGuard(entry);
        assert.strictEqual(fs.readlinkSync(path.join(ws, '.claude')), path.join(mine, 'claude'), 'the link a person made is kept');
        assert.strictEqual(fs.readFileSync(path.join(mine, 'claude', 'settings.json'), 'utf-8'), 'mine', 'and the change through it is put back');
        glue.guardCodexTurn(entry, 'convo-1');
        fs.unlinkSync(path.join(ws, '.claude'));
        fs.symlinkSync(outside, path.join(ws, '.claude'));
        glue.releaseCodexTurnGuard(entry);
      } finally { d.restore(); }
      untouched();
      assert.strictEqual(fs.readlinkSync(path.join(ws, '.claude')), path.join(mine, 'claude'), 'pointed back where the person had it');
      assert.strictEqual(fs.readFileSync(path.join(mine, 'claude', 'settings.json'), 'utf-8'), 'mine');
    } finally { fs.rmSync(mine, { recursive: true, force: true }); }
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
