'use strict';
// Seam tests for lib/protocol/handlers/. The handlers' behaviour is pinned
// by the characterisation suites driving a booted server over real
// WebSockets (http-api, workspace-lifecycle, conversation-metadata,
// session-history, search, chat-close and friends); these tests pin the
// SEAMS themselves: the dispatch table routes exactly the enumerated
// message types (and never the four root shims), the composition root's
// context object keeps the spec-frozen member list with identity-preserved
// live state, and handlers reach root capabilities only through ctx.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const { _internal: srv } = require('../../server.js');
const config = require('../../lib/config.js');

// The full routing surface of the dispatch table, frozen: 31 message types
// plus save_agent's two legacy aliases. The four root shims (chat, delegate,
// end_delegation, flush_buffer) must NEVER appear here: chat is the
// kill-window chat shim, delegate/end_delegation are delegation glue, and
// flush_buffer drains safeSend's own reconnect buffer.
const EXPECTED_TYPES = [
  'permission_response', 'cancel',
  'get_workspaces', 'client_render_time', 'list_workspaces', 'set_workspace',
  'pick_folder', 'create_workspace', 'set_workspace_mode',
  'get_agents', 'get_runtime_status', 'get_files', 'get_skills',
  'get_conversations', 'set_last_active_conversation', 'save_conversation',
  'get_lists', 'create_list', 'delete_list', 'delete_conversation',
  'read_file', 'add_to_team',
  'save_agent', 'create_agent', 'update_agent', 'delete_agent',
  'save_skill', 'delete_skill',
  'search_conversations', 'search_universal', 'get_session_history',
  'save_file', 'create_path', 'reveal_in_finder',
];

function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}

describe('dispatch table', () => {
  test('routes exactly the enumerated message types, every entry a function', () => {
    const table = buildDispatch();
    assert.deepStrictEqual(Object.keys(table).sort(), [...EXPECTED_TYPES].sort(),
      'the dispatch table carries exactly the frozen routing surface');
    for (const [type, fn] of Object.entries(table)) {
      assert.strictEqual(typeof fn, 'function', `${type} maps to a handler function`);
    }
  });

  test('save_agent legacy aliases map to the same handler by identity', () => {
    const table = buildDispatch();
    assert.strictEqual(table.create_agent, table.save_agent);
    assert.strictEqual(table.update_agent, table.save_agent);
  });

  test('the four root shims never appear in the table', () => {
    const table = buildDispatch();
    for (const shim of ['chat', 'delegate', 'end_delegation', 'flush_buffer']) {
      assert.ok(!(shim in table), `${shim} stays a root shim`);
    }
  });
});

describe('the composition root context (spec-frozen member list)', () => {
  test('carries exactly the eleven frozen members', () => {
    assert.deepStrictEqual(Object.keys(srv.wsHandlerContext).sort(), [
      'agents', 'broadcast', 'clients', 'config', 'pendingPermissions',
      'processes', 'runtime', 'signals', 'store', 'transitions', 'workspace',
    ], 'the context member list is frozen by the decomposition spec');
  });

  test('live state members are the root objects by identity', () => {
    assert.strictEqual(srv.wsHandlerContext.processes, srv.chatProcesses,
      'ctx.processes IS the live process map');
    assert.strictEqual(srv.wsHandlerContext.clients, srv.connectedClients,
      'ctx.clients IS the connected socket set');
    assert.strictEqual(srv.wsHandlerContext.pendingPermissions, srv.pendingPermissionRequests,
      'ctx.pendingPermissions IS the pending permission map');
    assert.strictEqual(srv.wsHandlerContext.config, config,
      'ctx.config IS the lib config module');
  });

  test('the root dispatch uses the same table shape as buildDispatch', () => {
    assert.deepStrictEqual(Object.keys(srv.wsDispatch).sort(), [...EXPECTED_TYPES].sort(),
      'the wired table routes the same frozen surface');
  });
});

describe('handler seams (stub ctx, capture ws)', () => {
  test('set_workspace_mode persists through lib state at the use-time workspace', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-handlers-'));
    try {
      config.setWorkspace(dir);
      const ws = captureWs();
      table.set_workspace_mode({}, ws, { type: 'set_workspace_mode', mode: 'code' });
      assert.deepStrictEqual(ws.sent, [{ type: 'workspace_mode_changed', mode: 'code' }]);
      const state = JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'state.json'), 'utf-8'));
      assert.strictEqual(state.workspaceMode, 'code', 'mode persisted in the CURRENT workspace');
      const ws2 = captureWs();
      table.set_workspace_mode({}, ws2, { type: 'set_workspace_mode', mode: 'sideways' });
      assert.strictEqual(ws2.sent[0].type, 'workspace_error', 'invalid modes are refused');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('set_workspace rolls the root back and answers when the open path throws', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-handlers-'));
    const rolledBack = [];
    const invalidated = [];
    const ctx = {
      signals: { phaseTimer: () => { throw new Error('prepare exploded'); } },
      runtime: { killAllChildren: () => {} },
      workspace: {
        setWorkspaceRoot: (d) => { rolledBack.push(d); config.setWorkspace(d); },
        // The open path baselines the file-tree poller against the new
        // directory before anything that can throw, so the rollback has to
        // put the poller back or the failed workspace's tree is served as if
        // it were this one. Arming clears the tree cache as part of arming.
        armFileTreeWatcher: () => invalidated.push('tree-watch'),
      },
      agents: { invalidateAgentCache: () => invalidated.push('agents') },
      store: { clearSearchFailure: () => invalidated.push('search') },
    };
    try {
      const ws = captureWs();
      table.set_workspace(ctx, ws, { type: 'set_workspace', path: dir });
      assert.strictEqual(ws.sent.length, 1, 'exactly one reply, never silence');
      assert.strictEqual(ws.sent[0].type, 'workspace_error');
      assert.match(ws.sent[0].message, /^Could not open workspace: prepare exploded$/);
      assert.deepStrictEqual(rolledBack, [original], 'the previous root was restored');
      // Order matters: the established steps must complete before the newer
      // tree-poller rollback, because one catch covers the whole block.
      assert.deepStrictEqual(invalidated, ['agents', 'search', 'tree-watch'],
        'caches cleared and the tree poller re-armed after rollback');
      assert.strictEqual(config.getWorkspace(), original, 'no half-switch persists');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('set_workspace still answers when even the rollback throws', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-handlers-'));
    const ctx = {
      signals: { phaseTimer: () => { throw new Error('prepare exploded'); } },
      runtime: { killAllChildren: () => {} },
      workspace: { setWorkspaceRoot: () => { throw new Error('rollback exploded too'); } },
      agents: { invalidateAgentCache: () => {} },
      store: { clearSearchFailure: () => {} },
    };
    try {
      const ws = captureWs();
      table.set_workspace(ctx, ws, { type: 'set_workspace', path: dir });
      assert.strictEqual(ws.sent.length, 1, 'the reply survives a failed rollback');
      assert.strictEqual(ws.sent[0].type, 'workspace_error');
      assert.match(ws.sent[0].message, /^Could not open workspace: prepare exploded$/,
        'the ORIGINAL failure is reported, not the rollback failure');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('create_path routes its guard through ctx.workspace', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-handlers-'));
    try {
      config.setWorkspace(dir);
      const asked = [];
      const ctx = { workspace: {
        isInsideWorkspace: () => true,
        isSafeCreatePath: (rel) => { asked.push(rel); return false; },
      } };
      const ws = captureWs();
      table.create_path(ctx, ws, { type: 'create_path', path: 'notes/x.md', kind: 'file' });
      assert.deepStrictEqual(asked, ['notes/x.md'], 'the injected guard was consulted');
      assert.deepStrictEqual(ws.sent, [{ type: 'create_error', path: 'notes/x.md', reason: 'invalid path' }]);
      assert.ok(!fs.existsSync(path.join(dir, 'notes')), 'nothing was created');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The error path in handleCreatePath: the catch that answers create_error
  // when the create itself throws, as opposed to the two guard branches above
  // it that refuse a path before touching the disk.
  //
  // WHY THIS TEST EXISTS AT ALL. Those two lines were already counted as
  // covered, but by accident: whichever test happened to make a create throw
  // picked them up, and when a run interleaved so that none did, the file
  // measured 95.3% against a 97.5% floor and the floors job went red on
  // changes that touched neither file. A floor held up by incidental coverage
  // protects nothing and reports a number that is not about the tests.
  //
  // The throw is real, not injected: `notes` is created as a FILE, so the
  // handler's own `fs.mkdirSync(path.dirname(full), { recursive: true })`
  // fails EEXIST on it. The path clears both guards on their own terms, so
  // the message reaches the try for the same reason a real one would.
  // Asserting the
  // errno reason rather than merely "a create_error was sent" is what
  // separates this from the branch above: the guards answer with the fixed
  // strings 'invalid path' and 'already exists', so an EEXIST reason can only
  // have come from the catch.
  test('create_path answers create_error carrying the failure reason when the create itself throws', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-handlers-'));
    try {
      config.setWorkspace(dir);
      // The obstruction: a regular file where the handler must make a folder.
      fs.writeFileSync(path.join(dir, 'notes'), 'not a directory', 'utf-8');
      let broadcasts = 0;
      const ctx = {
        workspace: {
          // Real containment against this workspace rather than `() => true`:
          // server.js's own isInsideWorkspace reads a module-local WORKSPACE
          // that config.setWorkspace does not touch, so it cannot be borrowed
          // here, but the rule it applies can be. isSafeCreatePath is pure and
          // is used as it ships.
          isInsideWorkspace: (p) => path.resolve(p).startsWith(path.resolve(dir) + path.sep),
          isSafeCreatePath: srv.isSafeCreatePath,
          invalidateFileListCache: () => {},
          invalidateFileTreeCache: () => {},
          broadcastFileTree: () => { broadcasts++; },
        },
        store: { ensureSearchEngine: () => null },
      };
      const ws = captureWs();
      table.create_path(ctx, ws, { type: 'create_path', path: 'notes/x.md', kind: 'file', content: 'hi' });

      assert.strictEqual(ws.sent.length, 1, 'exactly one answer');
      const [answer] = ws.sent;
      assert.strictEqual(answer.type, 'create_error');
      assert.strictEqual(answer.path, 'notes/x.md');
      // The errno text, which no guard branch can produce.
      assert.match(answer.reason, /^EEXIST:/, `the catch reported the real failure, got ${answer.reason}`);
      assert.strictEqual(broadcasts, 0, 'a failed create broadcasts no tree');
      assert.ok(!fs.existsSync(path.join(dir, 'notes', 'x.md')), 'nothing was created');
      assert.ok(fs.statSync(path.join(dir, 'notes')).isFile(), 'the obstruction is untouched');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('get_skills answers from ctx.agents.discoverSkills', () => {
    const table = buildDispatch();
    const ctx = { agents: { discoverSkills: () => [{ id: 'linting', name: 'Linting' }] } };
    const ws = captureWs();
    table.get_skills(ctx, ws, { type: 'get_skills' });
    assert.deepStrictEqual(ws.sent, [{ type: 'skills', skills: [{ id: 'linting', name: 'Linting' }] }]);
  });

  test('save_agent and save_skill answer Invalid path when the boundary guard refuses', () => {
    // The guard is injected (ctx.workspace.isInsideWorkspace); a refusal must
    // produce the error card, write nothing, and skip the roster broadcast.
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-handlers-'));
    try {
      config.setWorkspace(dir);
      const ctx = {
        workspace: { isInsideWorkspace: () => false },
        agents: { validateAgentSlug: () => true },
      };
      const wsA = captureWs();
      table.save_agent(ctx, wsA, { type: 'save_agent', name: 'sneaky', content: 'x' });
      assert.deepStrictEqual(wsA.sent, [{ type: 'agent_error', message: 'Invalid path.' }]);
      const wsS = captureWs();
      table.save_skill(ctx, wsS, { type: 'save_skill', name: 'sneaky', content: 'x' });
      assert.deepStrictEqual(wsS.sent, [{ type: 'skill_error', message: 'Invalid path.' }]);
      // The agents DIR is pre-created before the guard runs (pre-existing
      // behaviour); the refusal must still write no agent file and no skill.
      assert.ok(!fs.existsSync(path.join(dir, '.claude', 'agents', 'sneaky.md')), 'no agent file written');
      assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills', 'sneaky')), 'no skill dir created');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cancel seams (stub ctx)', () => {
  test('cancel with no active or an idle process is a silent no-op', () => {
    const table = buildDispatch();
    const sent = [];
    const ctx = { processes: new Map(), pendingPermissions: new Map(), broadcast: (m) => sent.push(m) };
    table.cancel(ctx, captureWs(), { type: 'cancel', conversationId: 'nope' });
    assert.deepStrictEqual(sent, [], 'nothing to cancel, nothing broadcast');
    const idle = { idle: true, exited: false, processId: 'p1', agentId: 'penn' };
    ctx.processes.set('c-idle', idle);
    table.cancel(ctx, captureWs(), { type: 'cancel', conversationId: 'c-idle' });
    assert.deepStrictEqual(sent, [], 'an idle process is not cancelled');
    assert.ok(!idle.cancelled, 'the idle entry is untouched');
  });

  test('cancel reaps a parked intercepted orchestrator (orchestratorEntry) AND the parent chain', () => {
    const table = buildDispatch();
    const fakeProc = () => ({ pid: 999999901, killed: [], kill(sig) { this.killed.push(sig); } });
    const grandparent = { agentId: 'cos', exited: false, process: fakeProc() };
    const orch = { agentId: 'orch', exited: false, process: fakeProc() };
    const parent = { agentId: 'lead', exited: false, process: fakeProc(),
      delegation: { originalEntry: grandparent, orchestratorEntry: null } };
    const child = { agentId: 'sub', exited: false, idle: false, processId: 'p9', agentId2: null,
      process: fakeProc(), toolCalls: [], turnStartTime: 1,
      delegation: { originalEntry: parent, orchestratorEntry: orch } };
    const sent = [];
    const ctx = { processes: new Map([['c9', child]]), pendingPermissions: new Map(), broadcast: (m) => sent.push(JSON.parse(m)) };
    table.cancel(ctx, captureWs(), { type: 'cancel', conversationId: 'c9' });
    assert.ok(child.cancelled && child.exited, 'the delegate is cancelled');
    assert.ok(orch.exited && orch.cancelled, 'the parked intercepted orchestrator is reaped');
    assert.ok(parent.exited && parent.cancelled, 'the parked parent is reaped');
    assert.ok(grandparent.exited && grandparent.cancelled, 'the grandparent is reaped through the chain');
    assert.ok(!ctx.processes.has('c9'), 'the entry is removed');
    assert.deepStrictEqual(sent.map(m => m.subtype), ['cancelled', 'done'], 'client unblocks in order');
  });
});
