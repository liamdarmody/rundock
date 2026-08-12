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

  test('get_skills answers from ctx.agents.discoverSkills', () => {
    const table = buildDispatch();
    const ctx = { agents: { discoverSkills: () => [{ id: 'linting', name: 'Linting' }] } };
    const ws = captureWs();
    table.get_skills(ctx, ws, { type: 'get_skills' });
    assert.deepStrictEqual(ws.sent, [{ type: 'skills', skills: [{ id: 'linting', name: 'Linting' }] }]);
  });
});
