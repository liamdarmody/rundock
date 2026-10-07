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

// The full routing surface of the dispatch table, frozen: 65 message types
// plus save_agent's two legacy aliases, 67 keys in all.
//
// THE NUMBER WAS COUNTED, NOT CARRIED OVER. Both sides of the 0.14 rail merge
// quoted a figure here, 44 on the rail and 45 on main, and the list each sat
// above already held far more than either claimed: the count had been stale
// for a long time on both, because the assertion below compares the LIST
// against the table and never reads this sentence. A comment that states a
// number nothing checks is the same defect this release found four times in
// shipped copy, in a file whose whole purpose is to freeze a surface.
//
// RECOUNTED AGAIN at the 0.15 packages merge, for the same reason: the
// packages branch carried 58 and main 57, sharing 48, so the union is 67
// rather than either figure or their sum. Counted from the list below. The four root shims (chat, delegate,
// end_delegation, flush_buffer) must NEVER appear here: chat is the
// kill-window chat shim, delegate/end_delegation are delegation glue, and
// flush_buffer drains safeSend's own reconnect buffer.
// There is no sandbox switch. Two messages reach the OS write block and no
// third: set_workspace_mode decides whether Rundock claims the enable, and
// set_working_folders decides which paths the block names, rewriting it for
// whatever mode the workspace is already in. Both are proven end to end,
// the first by test/unit/workspace-boundary.test.js and the second by
// 'naming a folder reaches the operating system' below.
const EXPECTED_TYPES = [
  'permission_response', 'cancel',
  'get_workspaces', 'client_render_time', 'list_workspaces', 'set_workspace',
  'pick_folder', 'create_workspace', 'set_workspace_mode',
  // Keep agents inside this workspace: its status, its own switch, and the
  // one-time notice. Pressed by test/unit/sandbox-status.test.js.
  'get_sandbox_status', 'set_workspace_sandbox', 'dismiss_sandbox_notice',
  // Bringing a person's own sandbox rules in: review, then import. Pressed by
  // test/unit/sandbox-import.test.js.
  'review_sandbox_import', 'import_sandbox_rules',
  // The folders a workspace names besides itself. One message sets the whole
  // list, because adding and removing are the same act on the store and a
  // narrower pair would have to agree about normalisation.
  'set_working_folders', 'get_working_folders',
  // The standing answers to "Always allow" on a permission card. Three verbs
  // rather than one: listing, granting and revoking have different
  // consequences, and a single message would have to carry the verb as data.
  'get_tool_allows', 'add_tool_allow', 'remove_tool_allow',
  'get_agents', 'get_runtime_status', 'get_files', 'get_skills', 'get_run',
  'cancel_routine_run',
  // The row's Run control: a pressed run through the scheduler's own
  // single-flight entry, refused only for what cannot produce a run.
  'run_routine_now',
  // The package review's projection message: the submitted decisions are
  // evaluated without writing, driven in test/unit/collision-decisions.test.js.
  'plan_package_import', 'evaluate_package_decisions', 'apply_package_import',
  // The extension mount reads: the installed roster, and one renderer's
  // payload. Driven through the dispatch table in the handler-seam tests
  // below, against a real temporary workspace.
  'list_extensions', 'get_extension_ui',
  // The extension install flow: acquire-and-offer, one answer either way.
  // Updates and removal are the package's (below). Pressed by test/unit/extension-install.test.js.
  'plan_package_install', 'confirm_extension_install',
  'confirm_package_install', 'decline_package_install',
  // The manage page: enablement written onto the record, and the page's
  // one read of the roster with the receipts. Pressed by
  // test/unit/packages-manage.test.js.
  'set_extension_enabled', 'set_extensions_all_off', 'get_packages_page',
  // A package's update check: only when asked, answered asynchronously.
  // Pressed by test/unit/package-update-check.test.js.
  'check_package_update', 'plan_package_update', 'confirm_package_update', 'clear_package_updates',
  // Uninstalling a package: pressed by test/unit/package-uninstall.test.js.
  'plan_package_uninstall', 'confirm_package_uninstall',
  'get_conversations', 'set_last_active_conversation', 'save_conversation',
  'get_lists', 'create_list', 'delete_list', 'delete_conversation',
  'read_file', 'add_to_team',
  'save_agent', 'create_agent', 'update_agent', 'delete_agent',
  'save_skill', 'delete_skill',
  // The one file an agent cannot write for itself: .mcp.json is protected
  // wherever it lives, so a connector reaches the file through Rundock or
  // not at all. Measured, after two agents were refused editing it directly.
  'save_connector', 'delete_connector',
  'save_routine', 'delete_routine', 'set_routine_paused',
  'set_routine_enabled', 'set_routine_schedule', 'approve_routine_plan',
  'allow_held_routines', 'dismiss_held_routines',
  'search_conversations', 'search_universal', 'get_session_history',
  'save_file', 'create_path', 'reveal_in_finder',
  // Named sources for an extension view, pressed by
  // test/unit/named-sources-transport.test.js.
  'get_sources', 'unwatch_sources', 'save_source',
  // An extension view's own state, named by the page from its mount
  // (test/unit/view-state-handler.test.js).
  'get_view_state', 'set_view_state',
  // File pins: the list a person keeps on this machine, keyed by workspace.
  // Each answers `pins` with the whole list; a pin outside the workspace is
  // refused with no write (test/unit/pins-store.test.js).
  'get_pins', 'pin_file', 'unpin_file',
];

function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}

describe('dispatch table', () => {
  test('a connector write refuses every way the file can be untrustworthy, and destroys nothing', () => {
    // .mcp.json is the one file an agent cannot write for itself, so Rundock
    // writes it. That makes Rundock responsible for the property the removed
    // add form carried: NEVER WRITE FROM BYTES YOU DID NOT READ. Every refusal
    // below leaves the file exactly as it was, because a merge built on a
    // failed or unparsable read drops every server already configured, which
    // for anyone with more than one connector is the whole file.
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-connectors-'));
    const file = path.join(dir, '.mcp.json');
    try {
      config.setWorkspace(dir);
      const ctx = { workspace: { isInsideWorkspace: () => true }, agents: { validateAgentSlug: () => true } };

      // An entry that is not JSON, and one that is JSON but not an object.
      let w = captureWs();
      table.save_connector(ctx, w, { name: 'x', content: 'not json' });
      assert.match(w.sent[0].message, /not valid JSON/);
      w = captureWs();
      table.save_connector(ctx, w, { name: 'x', content: '["a"]' });
      assert.match(w.sent[0].message, /must be an object/);
      assert.ok(!fs.existsSync(file), 'and neither created the file');

      // A file holding something that is not an object at all.
      fs.writeFileSync(file, '["not", "an", "object"]');
      w = captureWs();
      table.save_connector(ctx, w, { name: 'x', content: '{}' });
      assert.match(w.sent[0].message, /does not hold an object/);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), '["not", "an", "object"]', 'untouched');

      // A file whose mcpServers is the wrong shape is repaired rather than
      // refused: the servers map is what this owns, and an object with no
      // usable map is an empty one.
      fs.writeFileSync(file, '{"mcpServers": "nonsense"}');
      w = captureWs();
      table.save_connector(ctx, w, { name: 'x', content: '{"url":"https://x"}' });
      assert.strictEqual(w.sent[0].type, 'connector_saved');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers, { x: { url: 'https://x' } });

      // A file that exists and cannot be READ. Same precedent as the other
      // unreadable-file tests in this suite.
      fs.chmodSync(file, 0o000);
      w = captureWs();
      table.save_connector(ctx, w, { name: 'y', content: '{}' });
      fs.chmodSync(file, 0o644);
      assert.match(w.sent[0].message, /could not be read, so nothing was changed/);
      assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers), ['x'],
        'and what it held is still there');

      // A file that reads but cannot be WRITTEN.
      fs.chmodSync(file, 0o444);
      w = captureWs();
      table.save_connector(ctx, w, { name: 'z', content: '{}' });
      fs.chmodSync(file, 0o644);
      assert.match(w.sent[0].message, /could not be written/);

      // Deleting refuses the same ways, and refuses a name that is a path.
      w = captureWs();
      table.delete_connector(ctx, w, { name: '../../etc/passwd' });
      assert.match(w.sent[0].message, /Invalid connector name/);
    } finally {
      try { fs.chmodSync(file, 0o644); } catch (e) { /* already gone */ }
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a connector path outside the workspace is refused before anything is read', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-connectors-out-'));
    try {
      config.setWorkspace(dir);
      const ctx = { workspace: { isInsideWorkspace: () => false }, agents: { validateAgentSlug: () => true } };
      const w = captureWs();
      table.save_connector(ctx, w, { name: 'x', content: '{}' });
      assert.deepStrictEqual(w.sent, [{ type: 'connector_error', message: 'Invalid path.' }]);
      assert.ok(!fs.existsSync(path.join(dir, '.mcp.json')), 'nothing written');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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

  // THE WORKING FOLDERS HANDLERS, driven against a real temporary workspace so
  // what is stored and what is answered are both the real thing. The refusals
  // are exercised rather than assumed, because each one exists to keep a bad
  // list off disk and an untested refusal is a refusal nobody has seen work.
  function workingFoldersWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-wf-'));
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    return dir;
  }

  test('removing a folder takes it out of the sandbox too, not only adding one puts it in', () => {
    // The addition direction alone would pass with a block that only ever
    // grows: a folder removed in the interface but still writable at the
    // syscall level is a setting that lies in the direction that matters.
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = workingFoldersWorkspace();
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-wf-kept-'));
    const dropped = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-wf-dropped-'));
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    try {
      config.setWorkspace(dir);
      table.set_working_folders({}, captureWs(), { type: 'set_working_folders', folders: [kept, dropped] }, 'darwin');
      let roots = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).sandbox.filesystem.allowWrite;
      assert.ok(roots.includes(path.resolve(dropped)), 'fixture sanity: both folders are in the block first');

      table.set_working_folders({}, captureWs(), { type: 'set_working_folders', folders: [kept] }, 'darwin');
      roots = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).sandbox.filesystem.allowWrite;
      assert.ok(roots.includes(path.resolve(kept)), 'the folder that stayed is still writable');
      assert.ok(!roots.includes(path.resolve(dropped)),
        'and the one removed is no longer writable, without waiting for a mode switch or a restart');
    } finally {
      config.setWorkspace(original);
    }
  });

  test('a folder is still stored when the sandbox write fails, and the failure is not silent to the log', () => {
    // The stored list stands on its own: the folders are in effect for every
    // agent spawned from here, and scaffoldWorkspace reconciles the block
    // again on the next workspace open. Discarding a list a person just chose
    // because a settings file could not be written would cost more than the
    // delay it saves, so this path warns and carries on.
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = workingFoldersWorkspace();
    const named = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-wf-failwrite-'));
    // Corrupt rather than absent: reconcileSandboxForMode treats ENOENT as an
    // empty file and every other read failure as a reason to raise, precisely
    // so a settings file it cannot parse is never overwritten.
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    const corrupt = '{ this is not json';
    fs.writeFileSync(settingsPath, corrupt);
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      config.setWorkspace(dir);
      const ws = captureWs();
      table.set_working_folders({}, ws, { type: 'set_working_folders', folders: [named] }, 'darwin');
      assert.strictEqual(ws.sent[0].type, 'working_folders', 'the caller is answered, not errored');
      assert.deepStrictEqual(ws.sent[0].folders.map(f => f.path), [path.resolve(named)],
        'and the folder is stored, because the hook can honour it whatever the settings file says');
      assert.ok(warnings.some(w => w.includes('the sandbox was not updated')),
        'the failure reaches the log rather than vanishing');
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), corrupt,
        'and the unparsable file is left exactly as it was, never rewritten from empty');
    } finally {
      console.warn = realWarn;
      config.setWorkspace(original);
    }
  });

  test('naming a folder reaches the operating system, not only the permission hook', () => {
    // The hook is handed the folder list at every spawn; the sandbox is told
    // once, in a file written at scaffold and mode-change time. Without a
    // rewrite here, a folder named in this setting worked for file tools and
    // not for the shell, which is the same split between the two instruments
    // that the working-folder sandbox change exists to close.
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = workingFoldersWorkspace();
    const named = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-wf-sandbox-'));
    try {
      config.setWorkspace(dir);
      // 'darwin' explicitly: no block is written for any other platform, so a
      // call defaulted to process.platform asserts nothing on a Linux runner.
      table.set_working_folders({}, captureWs(), { type: 'set_working_folders', folders: [named] }, 'darwin');
      const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
      assert.ok(settings.sandbox.filesystem.allowWrite.includes(path.resolve(named)),
        'the folder just named is writable, without waiting for a mode switch or a restart');
    } finally {
      config.setWorkspace(original);
    }
  });

  test('set_working_folders stores the list, answers with it, and reports what it refused', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = workingFoldersWorkspace();
    const named = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-wf-named-'));
    try {
      config.setWorkspace(dir);
      const ws = captureWs();
      // One storable folder, one that can never be stored. The refusal is
      // NAMED in the reply: a row that vanishes with no reason given is how a
      // person stops trusting a setting.
      table.set_working_folders({}, ws, { type: 'set_working_folders', folders: [named, 'not-absolute'] });
      assert.strictEqual(ws.sent[0].type, 'working_folders');
      // STORED AS TYPED, resolved but not followed through symlinks. The store
      // decides nothing about permissions and the hook canonicalises every
      // entry itself at comparison time, so resolving links here would only
      // show a person a path they never typed. On macOS this is the difference
      // between /tmp and /private/tmp for the same folder.
      const stored = path.resolve(named);
      assert.deepStrictEqual(ws.sent[0].folders.map(f => f.path), [stored]);
      assert.deepStrictEqual(ws.sent[0].rejected, ['not-absolute'], 'the refused entry is named back');
      assert.strictEqual(typeof ws.sent[0].home, 'string', 'the home folder travels with the list');

      const state = JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'state.json'), 'utf-8'));
      assert.deepStrictEqual(state.workingFolders, [stored], 'and only the storable one persisted');

      // Read back through the other handler, which resolves existence at read
      // time rather than trusting what was written earlier.
      const reader = captureWs();
      table.get_working_folders({}, reader, { type: 'get_working_folders' });
      assert.deepStrictEqual(reader.sent[0].folders, [{ path: stored, missing: false }]);

      // A folder that has gone is reported as missing, never dropped.
      fs.rmSync(named, { recursive: true, force: true });
      const after = captureWs();
      table.get_working_folders({}, after, { type: 'get_working_folders' });
      assert.deepStrictEqual(after.sent[0].folders, [{ path: stored, missing: true }],
        'the row survives its folder');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(named, { recursive: true, force: true });
    }
  });

  test('the working folders handlers refuse rather than guess when there is nothing to write to', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    try {
      config.setWorkspace(null);
      const noWorkspace = captureWs();
      table.set_working_folders({}, noWorkspace, { type: 'set_working_folders', folders: ['/tmp'] });
      assert.strictEqual(noWorkspace.sent[0].type, 'workspace_error');
      assert.match(noWorkspace.sent[0].message, /Open a workspace/);

      // The READ answers an empty list rather than an error: a client asking
      // what is named before a workspace is open has asked a fair question.
      const reader = captureWs();
      table.get_working_folders({}, reader, { type: 'get_working_folders' });
      assert.deepStrictEqual(reader.sent[0].folders, []);
      assert.strictEqual(reader.sent[0].type, 'working_folders');
    } finally {
      config.setWorkspace(original);
    }
  });

  test('a message carrying no list is refused, rather than read as "name nothing"', () => {
    // The dangerous misreading: treating a malformed message as an empty list
    // would silently clear every folder a person had named.
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = workingFoldersWorkspace();
    try {
      config.setWorkspace(dir);
      for (const folders of [undefined, null, 'a string', 7]) {
        const ws = captureWs();
        table.set_working_folders({}, ws, { type: 'set_working_folders', folders });
        assert.strictEqual(ws.sent[0].type, 'workspace_error', `${String(folders)} is refused`);
        assert.match(ws.sent[0].message, /no list was sent/);
      }
      assert.strictEqual(fs.existsSync(path.join(dir, '.rundock', 'state.json')), false,
        'and nothing was written by any of them');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a write that fails is reported, not swallowed into a success', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = workingFoldersWorkspace();
    try {
      config.setWorkspace(dir);
      // .rundock as a FILE makes the state write throw, which is the shape a
      // real failure takes here (a permissions problem, a full disk).
      fs.rmSync(path.join(dir, '.rundock'), { recursive: true, force: true });
      fs.writeFileSync(path.join(dir, '.rundock'), 'not a directory');
      const ws = captureWs();
      table.set_working_folders({}, ws, { type: 'set_working_folders', folders: [os.tmpdir()] });
      assert.strictEqual(ws.sent[0].type, 'workspace_error');
      assert.match(ws.sent[0].message, /Could not save the working folders/);
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE EXTENSION MOUNT HANDLERS, driven against a real temporary workspace
  // so the envelopes are the ones the client would receive, and the
  // no-workspace path is exercised rather than assumed.
  function extensionWorkspace(fixture) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-ext-'));
    for (const [rel, content] of Object.entries(fixture)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return dir;
  }
  // THE INSTALL STORE, AS THE INSTALL FLOW WRITES IT: the records file and
  // the extensions root come from the writer's own exported layout, never
  // from a literal spelled here, so a store the writer moves is a store this
  // suite reads from the new place and the reader is held to it.
  const store = require('../../lib/packages/extension-record.js');
  const RECORDS_FILE = store.RECORDS_PATH;
  const EXT_DIR = `${store.EXTENSIONS_ROOT}/csv-echo`;
  const record = (extra = {}) => ({
    name: 'csv-echo', version: '1.2.0', entry: 'index.js', match: '*.csv',
    source: { url: 'https://github.com/example/csv-echo', reference: 'v1.2.0' },
    installedAt: '2026-09-07T00:00:00.000Z', root: EXT_DIR, ...extra,
  });
  const records = (...list) => JSON.stringify({ schema: store.RECORDS_SCHEMA, extensions: list });
  const manifest = (extension) => JSON.stringify({ name: 'csv-echo', version: '1.2.0', extension });

  function roster(fixture) {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = extensionWorkspace(fixture);
    try {
      config.setWorkspace(dir);
      const ws = captureWs();
      table.list_extensions({}, ws, { type: 'list_extensions' });
      assert.strictEqual(ws.sent.length, 1, 'one reply per request');
      return ws.sent[0];
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('the reader and the writer agree: a real install is what the roster and the payload read, through the layout the writer exports', () => {
    const registry = require('../../lib/packages/extension-registry.js');
    for (const key of ['RECORDS_PATH', 'RECORDS_SCHEMA', 'EXTENSIONS_ROOT']) {
      assert.strictEqual(registry[key], store[key], `${key} is one declaration, the writer's`);
    }
    assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'packages', 'extension-registry.js'), 'utf8'),
      /const \{ RECORDS_PATH, RECORDS_SCHEMA, EXTENSIONS_ROOT(, [A-Za-z]+)* \} = require\('\.\/extension-record\.js'\);/,
      'the reader imports the layout rather than re-spelling it');
    const { planExtensionInstall, installExtension } = require('../../lib/packages/extension-install.js');
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = extensionWorkspace({});
    const snapshot = extensionWorkspace({
      'rundock.json': JSON.stringify({ name: 'csv-echo', version: '1.2.0', extension: { entry: 'view/index.html', match: '*.csv' } }),
      'view/index.html': '<main>drawn</main>',
    });
    try {
      config.setWorkspace(dir);
      // The writer: the install transaction, over a snapshot shaped as an
      // extension ships. It materialises the entry's own top-level path and
      // leaves the manifest behind, so what the reader reads here is the
      // record's own copy of the declaration, the path real installs take.
      const written = installExtension(dir, snapshot, planExtensionInstall(dir, snapshot, { url: 'https://github.com/example/csv-echo', reference: 'v1.2.0' }));
      assert.strictEqual(written.root, EXT_DIR, 'the writer installs under the exported root');
      assert.strictEqual(fs.existsSync(path.join(dir, EXT_DIR, 'rundock.json')), false, 'sanity: no manifest is materialised');
      const ws = captureWs();
      table.list_extensions({}, ws, { type: 'list_extensions' });
      assert.strictEqual(ws.sent[0].type, 'extensions');
      const [entry] = ws.sent[0].extensions;
      assert.deepStrictEqual([entry.id, entry.version, entry.enabled, entry.renderers, entry.source],
        ['csv-echo', '1.2.0', true, [{ id: 'view', target: '.csv' }], { url: 'https://github.com/example/csv-echo', reference: 'v1.2.0' }],
        'the roster claims the renderer the record declares');
      const ui = captureWs();
      table.get_extension_ui({}, ui, { type: 'get_extension_ui', extensionId: 'csv-echo', rendererId: 'view' });
      assert.strictEqual(ui.sent[0].type, 'extension_ui');
      assert.strictEqual(ui.sent[0].entry, '<main>drawn</main>', 'the payload serves the entry the writer materialised');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(snapshot, { recursive: true, force: true });
    }
  });

  test('an installed directory with the entry but no manifest is read from the record: the roster claims it and the payload serves it', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = extensionWorkspace({
      [RECORDS_FILE]: records(record({ entry: 'view/index.html', match: '*.csv' })),
      [`${EXT_DIR}/view/index.html`]: '<main>from the record</main>',
    });
    try {
      config.setWorkspace(dir);
      const ws = captureWs();
      table.list_extensions({}, ws, { type: 'list_extensions' });
      assert.deepStrictEqual(ws.sent[0].extensions[0].renderers, [{ id: 'view', target: '.csv' }], 'built from the record, no manifest present');
      assert.deepStrictEqual(ws.sent[0].extensions[0].refusals, []);
      const ui = captureWs();
      table.get_extension_ui({}, ui, { type: 'get_extension_ui', extensionId: 'csv-echo', rendererId: 'view' });
      assert.strictEqual(ui.sent[0].type, 'extension_ui');
      assert.strictEqual(ui.sent[0].entry, '<main>from the record</main>');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unparsable records file makes the payload a refusal naming the reason, one reply, and the roster the same', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = extensionWorkspace({ [RECORDS_FILE]: '{ not json', [`${EXT_DIR}/index.js`]: 'draw();' });
    try {
      config.setWorkspace(dir);
      const ui = captureWs();
      table.get_extension_ui({}, ui, { type: 'get_extension_ui', extensionId: 'csv-echo', rendererId: 'view' });
      assert.strictEqual(ui.sent.length, 1, 'exactly one reply');
      assert.deepStrictEqual([ui.sent[0].type, ui.sent[0].extensionId, ui.sent[0].rendererId], ['extension_ui_error', 'csv-echo', 'view'],
        'the refusal names the ids the client correlates on');
      assert.match(ui.sent[0].reason, /records unreadable/);
      const { uiPayload } = require('../../lib/packages/extension-registry.js');
      assert.match(uiPayload(dir, 'csv-echo', 'view').reason, /records unreadable/, 'the reader itself refuses rather than throwing');
      const ws = captureWs();
      table.list_extensions({}, ws, { type: 'list_extensions' });
      assert.strictEqual(ws.sent[0].type, 'extensions_error');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every reply the client reads a roster from carries it as `extensions`, an array, in the shape the handler actually sends', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = extensionWorkspace({
      [RECORDS_FILE]: records(record()),
      [`${EXT_DIR}/rundock.json`]: manifest({ entry: 'index.js', match: '*.csv' }),
      [`${EXT_DIR}/index.js`]: 'draw();',
    });
    const ctx = { workspace: { noteExtensionRecordsChanged() {} }, agents: { invalidateAgentCache() {}, flagRosterRefresh() {} } };
    try {
      config.setWorkspace(dir);
      const page = captureWs();
      table.get_packages_page(ctx, page, { type: 'get_packages_page' });
      const state = captureWs();
      table.set_extension_enabled(ctx, state, { type: 'set_extension_enabled', name: 'csv-echo', enabled: false });
      const asked = captureWs();
      const source = 'https://github.com/example/csv-echo';
      table.plan_package_uninstall(ctx, asked, { type: 'plan_package_uninstall', source });
      const gone = captureWs();
      table.confirm_package_uninstall(ctx, gone, { type: 'confirm_package_uninstall', source, key: asked.sent[0].key });
      for (const [label, sock, type] of [['page', page, 'packages_page'], ['state', state, 'extension_state'], ['uninstall', gone, 'package_uninstall_result']]) {
        assert.strictEqual(sock.sent[0].type, type, label);
        assert.ok(Array.isArray(sock.sent[0].extensions), `${label}: the roster rides as an array under extensions`);
      }
      assert.strictEqual(state.sent[0].extensions[0].enabled, false, 'the state reply carries the roster after the change');
      assert.deepStrictEqual(gone.sent[0].extensions, [], 'the uninstall reply carries the roster after the removal');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('list_extensions answers the roster from the install store, and refuses with one reply when no workspace is open', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = extensionWorkspace({
      [RECORDS_FILE]: records(record()),
      [`${EXT_DIR}/rundock.json`]: manifest({ entry: 'index.js', match: '*.csv' }),
      [`${EXT_DIR}/index.js`]: 'draw();',
    });
    try {
      config.setWorkspace(dir);
      const ws = captureWs();
      table.list_extensions({}, ws, { type: 'list_extensions' });
      assert.strictEqual(ws.sent.length, 1);
      assert.strictEqual(ws.sent[0].type, 'extensions');
      assert.deepStrictEqual(ws.sent[0].extensions, [{
        id: 'csv-echo', name: 'csv-echo', version: '1.2.0', enabled: true,
        renderers: [{ id: 'view', target: '.csv' }], refusals: [], resources: [],
        source: { url: 'https://github.com/example/csv-echo', reference: 'v1.2.0' },
        installedAt: '2026-09-07T00:00:00.000Z',
      }], 'one roster entry per record, its renderer built from the declared entry and match rule, its source and install date carried for the manage page');

      config.setWorkspace(null);
      const ws2 = captureWs();
      table.list_extensions({}, ws2, { type: 'list_extensions' });
      assert.deepStrictEqual(ws2.sent, [{ type: 'extensions_error', reason: 'No workspace is open.' }]);
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a match of the form *.<ext> becomes the registry target .<ext>; any other rule is a named refusal, not a claim', () => {
    // One case per match shape. The registry grammar is one dot-prefixed
    // segment, so that is the only rule the roster may turn into a claim;
    // everything else stays on the roster as a refusal the manage surface
    // can show, because a silently dropped rule reads as a broken extension.
    const cases = [
      ['*.csv', { target: '.csv' }],
      ['*.CSV', { target: '.csv' }],
      ['*.tsv', { target: '.tsv' }],
      ['**/*.csv', { refused: true }],
      ['data/*.csv', { refused: true }],
      ['*.tar.gz', { refused: true }],
      ['csv', { refused: true }],
      ['*', { refused: true }],
    ];
    for (const [match, expected] of cases) {
      const reply = roster({
        [RECORDS_FILE]: records(record({ match })),
        [`${EXT_DIR}/rundock.json`]: manifest({ entry: 'index.js', match }),
        [`${EXT_DIR}/index.js`]: 'draw();',
      });
      assert.strictEqual(reply.type, 'extensions', `${match}: the roster answers`);
      const [ext] = reply.extensions;
      if (expected.target) {
        assert.deepStrictEqual(ext.renderers, [{ id: 'view', target: expected.target }], `${match}: mapped to ${expected.target}`);
        assert.deepStrictEqual(ext.refusals, [], `${match}: nothing refused`);
      } else {
        assert.deepStrictEqual(ext.renderers, [], `${match}: never a claim`);
        assert.strictEqual(ext.refusals.length, 1, `${match}: one named refusal`);
        assert.strictEqual(ext.refusals[0].match, match, `${match}: the refusal names the rule`);
        assert.match(ext.refusals[0].reason, /\*\.<ext>/, `${match}: the reason states the accepted form`);
      }
    }
  });

  test('a declares marker rides the roster renderer, from the manifest or the record\'s copy, and its absence keeps the old shape', () => {
    const fromManifest = roster({
      [RECORDS_FILE]: records(record()),
      [`${EXT_DIR}/rundock.json`]: manifest({ entry: 'index.js', match: '*.md', declares: 'standup-plugin' }),
      [`${EXT_DIR}/index.js`]: 'draw();',
    });
    assert.deepStrictEqual(fromManifest.extensions[0].renderers,
      [{ id: 'view', target: '.md', declares: 'standup-plugin' }],
      'the shipped manifest\'s marker is the claim');
    const fromRecord = roster({
      [RECORDS_FILE]: records(record({ match: '*.md', declares: 'standup-plugin' })),
      [`${EXT_DIR}/index.js`]: 'draw();',
    });
    assert.deepStrictEqual(fromRecord.extensions[0].renderers,
      [{ id: 'view', target: '.md', declares: 'standup-plugin' }],
      'no installed manifest: the record\'s copy stands in, the path real installs take');
    const bare = roster({
      [RECORDS_FILE]: records(record()),
      [`${EXT_DIR}/rundock.json`]: manifest({ entry: 'index.js', match: '*.csv' }),
      [`${EXT_DIR}/index.js`]: 'draw();',
    });
    assert.ok(!('declares' in bare.extensions[0].renderers[0]),
      'no marker, no field: every existing consumer reads the shape it always did');
  });

  test('a declares outside the key grammar is a named refusal on the roster, never a claim and never a silent widening', () => {
    const reply = roster({
      [RECORDS_FILE]: records(record({ match: '*.md', declares: 'Not A Key!' })),
      [`${EXT_DIR}/index.js`]: 'draw();',
    });
    const [ext] = reply.extensions;
    assert.deepStrictEqual(ext.renderers, [],
      'an unreadable marker never falls back to claiming the whole container');
    assert.strictEqual(ext.refusals.length, 1);
    assert.match(ext.refusals[0].reason, /frontmatter key/, 'the reason states the grammar');
    assert.strictEqual(ext.refusals[0].declares, 'Not A Key!', 'and names the marker it refused');
  });

  test('the core marker is refused on the roster: kanban stays Rundock\'s, and the reason reaches the managed row\'s entry', () => {
    const reply = roster({
      [RECORDS_FILE]: records(record({ match: '*.md', declares: 'kanban-plugin' })),
      [`${EXT_DIR}/index.js`]: 'draw();',
    });
    const [ext] = reply.extensions;
    assert.deepStrictEqual(ext.renderers, [], 'the claim the registry would refuse is not listed as working');
    assert.strictEqual(ext.refusals.length, 1);
    assert.match(ext.refusals[0].reason, /kanban-plugin/);
    assert.match(ext.refusals[0].reason, /Rundock/, 'the reason says whose the marker is');
  });

  test('two records declaring one marker: the first in roster order keeps it, the loser carries the refusal naming the holder', () => {
    const second = { ...record({ match: '*.md', declares: 'standup-plugin' }), name: 'z-standup', root: `${store.EXTENSIONS_ROOT}/z-standup` };
    const first = { ...record({ match: '*.md', declares: 'standup-plugin' }), name: 'a-standup', root: `${store.EXTENSIONS_ROOT}/a-standup` };
    const reply = roster({
      [RECORDS_FILE]: records(first, second),
      [`${store.EXTENSIONS_ROOT}/a-standup/index.js`]: 'draw();',
      [`${store.EXTENSIONS_ROOT}/z-standup/index.js`]: 'draw();',
    });
    const [winner, loser] = reply.extensions;
    assert.strictEqual(winner.id, 'a-standup');
    assert.deepStrictEqual(winner.renderers, [{ id: 'view', target: '.md', declares: 'standup-plugin' }]);
    assert.deepStrictEqual(loser.renderers, [], 'first claim wins, in the order the client registers in');
    assert.strictEqual(loser.refusals.length, 1);
    assert.match(loser.refusals[0].reason, /already rendered by a-standup/,
      'the refusal names the holder, so a silent renderer is explicable');
  });

  test('a disabled extension contests no marker: the enabled one keeps the claim, exactly as it keeps registration', () => {
    const off = { ...record({ match: '*.md', declares: 'standup-plugin', enabled: false }), name: 'a-standup', root: `${store.EXTENSIONS_ROOT}/a-standup` };
    const on = { ...record({ match: '*.md', declares: 'standup-plugin' }), name: 'z-standup', root: `${store.EXTENSIONS_ROOT}/z-standup` };
    const reply = roster({
      [RECORDS_FILE]: records(off, on),
      [`${store.EXTENSIONS_ROOT}/a-standup/index.js`]: 'draw();',
      [`${store.EXTENSIONS_ROOT}/z-standup/index.js`]: 'draw();',
    });
    const enabled = reply.extensions.find((e) => e.id === 'z-standup');
    assert.deepStrictEqual(enabled.renderers, [{ id: 'view', target: '.md', declares: 'standup-plugin' }]);
    assert.deepStrictEqual(enabled.refusals, [], 'nothing refused: the disabled entry registers nothing to lose to');
  });

  test('the record\'s enabled field is what the roster carries, and absent means enabled', () => {
    const shapes = [
      [{}, true],
      [{ enabled: true }, true],
      [{ enabled: false }, false],
    ];
    for (const [extra, enabled] of shapes) {
      const reply = roster({
        [RECORDS_FILE]: records(record(extra)),
        [`${EXT_DIR}/rundock.json`]: manifest({ entry: 'index.js', match: '*.csv' }),
        [`${EXT_DIR}/index.js`]: 'draw();',
      });
      assert.strictEqual(reply.extensions[0].enabled, enabled, `enabled ${JSON.stringify(extra)} carries ${enabled}`);
      assert.deepStrictEqual(reply.extensions[0].renderers, [{ id: 'view', target: '.csv' }],
        'the roster still names the renderer of a disabled extension; the client registry is what skips it');
    }
  });

  test('a record without entry and match is read from the extension\'s own rundock.json, and a manifest in the directory wins when both are present', () => {
    const fromManifest = roster({
      [RECORDS_FILE]: records({ name: 'csv-echo', version: '1.2.0', source: { url: 'u', reference: 'v1.2.0' } }),
      [`${EXT_DIR}/rundock.json`]: manifest({ entry: 'index.js', match: '*.csv' }),
      [`${EXT_DIR}/index.js`]: 'draw();',
    });
    assert.deepStrictEqual(fromManifest.extensions[0].renderers, [{ id: 'view', target: '.csv' }]);
    const both = roster({
      [RECORDS_FILE]: records(record({ match: '*.csv' })),
      [`${EXT_DIR}/rundock.json`]: manifest({ entry: 'index.js', match: '*.tsv' }),
      [`${EXT_DIR}/index.js`]: 'draw();',
    });
    assert.deepStrictEqual(both.extensions[0].renderers, [{ id: 'view', target: '.tsv' }],
      'the manifest the extension ships is the declaration; the record is the copy the install took of it');
    const neither = roster({
      [RECORDS_FILE]: records({ name: 'csv-echo', version: '1.2.0', source: { url: 'u', reference: 'v1.2.0' } }),
    });
    assert.strictEqual(neither.extensions[0].broken, true, 'no declaration anywhere is a broken record, reported rather than skipped');
    assert.strictEqual(neither.extensions[0].enabled, false);
  });

  test('an unreadable records file is a roster error carrying the reason, never an empty roster', () => {
    const reply = roster({ [RECORDS_FILE]: 'not json at all' });
    assert.strictEqual(reply.type, 'extensions_error');
    assert.match(reply.reason, /records unreadable/);
    const wrongSchema = roster({ [RECORDS_FILE]: JSON.stringify({ schema: 'something-else', extensions: [] }) });
    assert.strictEqual(wrongSchema.type, 'extensions_error');
  });

  test('the retired per-directory layout is read by nothing: it lists nothing and serves nothing', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = extensionWorkspace({
      '.rundock/plugins/charts/manifest.json': JSON.stringify({
        schemaVersion: 1, id: 'charts', renderers: [{ id: 'chart', target: '.chart', entry: 'ui/index.js' }],
      }),
      '.rundock/plugins/charts/ui/index.js': 'draw();',
      '.rundock/plugin-state.json': JSON.stringify({ plugins: { charts: { enabled: true } } }),
    });
    try {
      config.setWorkspace(dir);
      const ws = captureWs();
      table.list_extensions({}, ws, { type: 'list_extensions' });
      assert.deepStrictEqual(ws.sent, [{ type: 'extensions', extensions: [] }]);
      const ui = captureWs();
      table.get_extension_ui({}, ui, { type: 'get_extension_ui', extensionId: 'charts', rendererId: 'chart' });
      assert.strictEqual(ui.sent[0].type, 'extension_ui_error');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the file tree lists a file whose extension an enabled record claims, and stops when the record is disabled or removed', () => {
    const files = {
      'notes.md': '# notes',
      'sales.csv': 'a,b\n1,2\n',
      'data/more.csv': 'c,d\n',
      'data/readme.txt': 'plain',
      'script.py': 'print(1)',
    };
    const names = (tree) => tree.flatMap((n) => (n.type === 'folder' ? names(n.children) : [n.path])).sort();
    const build = (store) => {
      const dir = extensionWorkspace({ ...files, ...store });
      try { return names(srv.getFileTree(dir)); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    const withStore = (rec) => ({
      [RECORDS_FILE]: records(rec),
      [`${EXT_DIR}/rundock.json`]: manifest({ entry: 'index.js', match: '*.csv' }),
      [`${EXT_DIR}/index.js`]: 'draw();',
    });
    assert.deepStrictEqual(build({}), ['data/readme.txt', 'notes.md'],
      'with no record the built-in kinds alone are listed: never csv, never code');
    assert.deepStrictEqual(build(withStore(record())), ['data/more.csv', 'data/readme.txt', 'notes.md', 'sales.csv'],
      'an enabled record claiming *.csv lists every csv, at any depth');
    assert.deepStrictEqual(build(withStore(record({ enabled: false }))), ['data/readme.txt', 'notes.md'],
      'a disabled record claims nothing for the tree');
    assert.deepStrictEqual(build({ [RECORDS_FILE]: records() }), ['data/readme.txt', 'notes.md'],
      'a removed record claims nothing for the tree');
    assert.deepStrictEqual(build({ [RECORDS_FILE]: 'not json' }), ['data/readme.txt', 'notes.md'],
      'an unreadable roster claims nothing; the tree still stands');
    assert.strictEqual(typeof srv.noteExtensionRecordsChanged, 'function', 'the invalidation the install and manage flows call');
    assert.strictEqual(typeof srv.wsHandlerContext.workspace.noteExtensionRecordsChanged, 'function',
      'reachable through ctx.workspace, the way handlers reach every root file cache');
  });

  test('a records change alone makes the cached tree stale, and the invalidation call covers a change the stat cannot see', () => {
    // The records file lives under a dot directory the tree never walks, so
    // no directory mtime says it changed. The freshness pass stats the file
    // itself; the install and manage flows call noteExtensionRecordsChanged
    // as well, which is what catches a rewrite that lands on the same mtime.
    const original = config.getWorkspace();
    const dir = extensionWorkspace({
      'sales.csv': 'a,b\n',
      'notes.md': '# notes',
      [RECORDS_FILE]: records(record()),
      [`${EXT_DIR}/rundock.json`]: manifest({ entry: 'index.js', match: '*.csv' }),
      [`${EXT_DIR}/index.js`]: 'draw();',
    });
    const recordsFile = path.join(dir, RECORDS_FILE);
    const names = (tree) => tree.map((n) => n.path).sort();
    const cached = () => srv.wsHandlerContext.workspace.getFileTreeCached();
    try {
      srv.setWorkspace(dir);
      assert.deepStrictEqual(names(cached()), ['notes.md', 'sales.csv']);
      assert.strictEqual(cached(), cached(), 'an unchanged store is a cache hit by identity');
      // Disable the record; the file's mtime moves and nothing else does.
      fs.writeFileSync(recordsFile, records(record({ enabled: false })));
      const later = new Date(fs.statSync(recordsFile).mtimeMs + 5000);
      fs.utimesSync(recordsFile, later, later);
      assert.deepStrictEqual(names(cached()), ['notes.md'],
        'the next read rebuilt from the records file alone, with no directory change and no call');
      // Re-enable, but pin the mtime to the value the cache recorded (a whole
      // millisecond, so the pin is exact) so the stat cannot see it: only the
      // explicit call can.
      fs.writeFileSync(recordsFile, records(record()));
      fs.utimesSync(recordsFile, later, later);
      assert.deepStrictEqual(names(cached()), ['notes.md'], 'same mtime reads as fresh');
      srv.noteExtensionRecordsChanged();
      assert.deepStrictEqual(names(cached()), ['notes.md', 'sales.csv'],
        'the call the install and manage flows make rebuilds at once');
    } finally {
      srv.setWorkspace(null);
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('get_extension_ui serves the entry from the install store, and refuses cleanly on every bad input', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = extensionWorkspace({
      [RECORDS_FILE]: records(
        record(),
        record({ name: 'thief', entry: '../../../secrets.txt', root: '.rundock/extensions/thief' }),
      ),
      [`${EXT_DIR}/rundock.json`]: manifest({ entry: 'index.js', match: '*.csv' }),
      [`${EXT_DIR}/index.js`]: 'draw();',
      'secrets.txt': 'not yours',
    });
    try {
      config.setWorkspace(dir);
      const ok = captureWs();
      table.get_extension_ui({}, ok, { type: 'get_extension_ui', extensionId: 'csv-echo', rendererId: 'view' });
      assert.strictEqual(ok.sent.length, 1);
      assert.strictEqual(ok.sent[0].type, 'extension_ui');
      assert.strictEqual(ok.sent[0].entry, 'draw();');
      assert.deepStrictEqual(ok.sent[0].styles, []);

      const unknown = captureWs();
      table.get_extension_ui({}, unknown, { type: 'get_extension_ui', extensionId: 'csv-echo', rendererId: 'nope' });
      assert.strictEqual(unknown.sent[0].type, 'extension_ui_error');
      assert.match(unknown.sent[0].reason, /declares no renderer/);

      const missing = captureWs();
      table.get_extension_ui({}, missing, { type: 'get_extension_ui', extensionId: 'nobody', rendererId: 'view' });
      assert.strictEqual(missing.sent[0].type, 'extension_ui_error');
      assert.match(missing.sent[0].reason, /no installed extension named "nobody"/);

      // OMITTING THE RENDERER IS NOT A WILDCARD. A region extension asks
      // without naming one, because it declares no renderer at all: it draws a
      // fenced language instead. That made the id optional, and optional is
      // one step from ignored. This extension renders files and does have a
      // renderer, so asking without naming it is a caller that has not said
      // what it wants, and being handed the entry anyway would make the id
      // decorative for every extension that has one.
      const unnamed = captureWs();
      table.get_extension_ui({}, unnamed, { type: 'get_extension_ui', extensionId: 'csv-echo' });
      assert.strictEqual(unnamed.sent[0].type, 'extension_ui_error');
      assert.match(unnamed.sent[0].reason, /renders files, so a renderer must be named/);
      assert.strictEqual(unnamed.sent[0].entry, undefined,
        'refused means nothing is served, not that a reason rides alongside the entry');

      const escaping = captureWs();
      table.get_extension_ui({}, escaping, { type: 'get_extension_ui', extensionId: 'thief', rendererId: 'view' });
      assert.strictEqual(escaping.sent[0].type, 'extension_ui_error');
      assert.match(escaping.sent[0].reason, /inside the extension's own directory/);

      const pathy = captureWs();
      table.get_extension_ui({}, pathy, { type: 'get_extension_ui', extensionId: '../csv-echo', rendererId: 'view' });
      assert.strictEqual(pathy.sent[0].type, 'extension_ui_error');
      assert.match(pathy.sent[0].reason, /not an installed extension name/);

      config.setWorkspace(null);
      const noWs = captureWs();
      table.get_extension_ui({}, noWs, { type: 'get_extension_ui', extensionId: 'csv-echo', rendererId: 'view' });
      assert.strictEqual(noWs.sent.length, 1);
      assert.strictEqual(noWs.sent[0].type, 'extension_ui_error');
      assert.strictEqual(noWs.sent[0].reason, 'No workspace is open.');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('get_extension_ui carries the declared stylesheets to the client, guarded like the entry', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = extensionWorkspace({
      [RECORDS_FILE]: records(
        record(),
        record({ name: 'bare-record', root: `${store.EXTENSIONS_ROOT}/bare-record`, styles: ['table.css'] }),
        record({ name: 'style-thief', root: `${store.EXTENSIONS_ROOT}/style-thief` }),
      ),
      [`${EXT_DIR}/rundock.json`]: manifest({ entry: 'index.js', match: '*.csv', styles: ['table.css'] }),
      [`${EXT_DIR}/index.js`]: 'draw();',
      [`${EXT_DIR}/table.css`]: 'th{background:var(--elevated)}',
      [`${store.EXTENSIONS_ROOT}/bare-record/index.js`]: 'draw();',
      [`${store.EXTENSIONS_ROOT}/bare-record/table.css`]: 'td{color:var(--text-1)}',
      [`${store.EXTENSIONS_ROOT}/style-thief/rundock.json`]: JSON.stringify({
        name: 'style-thief', version: '1.2.0',
        extension: { entry: 'index.js', match: '*.csv', styles: ['../../../secret.css'] },
      }),
      [`${store.EXTENSIONS_ROOT}/style-thief/index.js`]: 'draw();',
      'secret.css': 'the workspace\'s own file',
    });
    try {
      config.setWorkspace(dir);
      const ws = captureWs();
      table.get_extension_ui({}, ws, { type: 'get_extension_ui', extensionId: 'csv-echo', rendererId: 'view' });
      assert.strictEqual(ws.sent.length, 1);
      assert.strictEqual(ws.sent[0].type, 'extension_ui');
      assert.deepStrictEqual(ws.sent[0].styles, ['th{background:var(--elevated)}'],
        'the reply forwards the stylesheet bytes the registry read, so the mount receives what the manifest declared');

      // The record's copy serves when the installed directory carries no
      // manifest, exactly as it does for the entry.
      const bare = captureWs();
      table.get_extension_ui({}, bare, { type: 'get_extension_ui', extensionId: 'bare-record', rendererId: 'view' });
      assert.strictEqual(bare.sent[0].type, 'extension_ui');
      assert.deepStrictEqual(bare.sent[0].styles, ['td{color:var(--text-1)}']);

      // A declared stylesheet that escapes the extension's directory
      // refuses the whole payload; the workspace's own file never travels.
      const escaping = captureWs();
      table.get_extension_ui({}, escaping, { type: 'get_extension_ui', extensionId: 'style-thief', rendererId: 'view' });
      assert.strictEqual(escaping.sent[0].type, 'extension_ui_error');
      assert.match(escaping.sent[0].reason, /inside the extension's own directory/);
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // EVERY WINDOW IS TOLD, NOT ONLY THE ONE THAT ASKED.
  //
  // There is one scheduler and it serves one workspace, and several windows
  // can be looking at one server: a browser on the laptop and one on the
  // phone, which is the setup the always-on documentation recommends. Only the
  // socket that asked used to hear about a switch, so every other window went
  // on drawing a next-run time against routines the scheduler had stopped
  // serving. Nothing on those screens was true and nothing on them said so.
  //
  // ASSERTED AS AN ABSENCE, DELIBERATELY. The notice originates in exactly
  // one place, the server's own root setter, and 'changing the root tells
  // every connected window which workspace it is' below drives that place
  // against real connected clients. What this one pins is the other half of
  // the single-source rule: the handler adds no copy of its own. The ctx here
  // stubs the root setter with one that announces nothing, so any notice on
  // the broadcast is one the handler itself sent, and the first version of
  // this change did exactly that: two senders, two transports, and a failure
  // path where the early copy described a root the server had rolled back.
  test('set_workspace announces through the root setter alone, never from the handler', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-handlers-'));
    const broadcast = [];
    const noop = () => {};
    const ctx = {
      signals: { phaseTimer: () => ({ mark: noop, summary: () => '' }), reportStartup: noop },
      runtime: { killAllChildren: noop, cleanOrphanedProcesses: noop },
      workspace: {
        setWorkspaceRoot: (d) => config.setWorkspace(d),
        armAgentsDirWatcher: noop, armFileTreeWatcher: noop, healWorkspaceIfMoved: noop,
        saveRecentWorkspace: noop, fileTreeForSend: () => [],
      },
      agents: { armAgentsDirWatcher: noop, invalidateAgentCache: noop },
      store: { clearSearchFailure: noop, ensureSearchEngine: noop },
      broadcast: (raw) => broadcast.push(JSON.parse(raw)),
    };
    try {
      const ws = captureWs();
      table.set_workspace(ctx, ws, { type: 'set_workspace', path: dir });
      assert.ok(ws.sent.some(m => m.type === 'workspace_set'),
        'sanity: the open path ran to the end rather than into the rollback');

      const notices = broadcast.filter(m => m.type === 'serving_workspace');
      assert.strictEqual(notices.length, 0,
        'the handler sent a serving-workspace notice of its own: the root setter is the one announcer, '
        + 'and a second sender is a second thing that can disagree with it on the failure path');

      // The roster the asking socket receives carries the same value, so a
      // window comparing rows against it is comparing two copies of one
      // string rather than two independently spelled paths.
      const roster = ws.sent.find(m => m.type === 'agents');
      assert.ok(roster, 'the asking socket still receives its roster');
      assert.strictEqual(roster.workspace, config.getWorkspace(),
        'and the workspace it was read from travels with it');
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
        isWritableInWorkspace: () => true,
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
  // Asserting the errno reason rather than merely "a create_error was sent"
  // is what separates this from the branch above: the guards answer with the
  // fixed strings 'invalid path' and 'already exists', so an EEXIST reason
  // can only have come from the catch.
  //
  // THE MEASUREMENT, since the claim is that the file now clears its floor
  // whatever else ran, and a claim like that is worth only the runs behind
  // it. SIX full coverage runs were made: one before this test and FIVE
  // after. Every figure below is `npm run test:coverage` against a floor of
  // 97.5%.
  //
  //   before, 1 run:  97.6%  (83/85), uncovered 81-82
  //   after,  run 1:  97.6%  (83/85), uncovered 81-82
  //   after,  run 2:  97.6%  (83/85), uncovered 81-82
  //   after,  run 3:  97.6%  (83/85), uncovered 81-82
  //   after,  run 4:  97.6%  (83/85), uncovered 81-82
  //   after,  run 5:  97.6%  (83/85), uncovered 81-82
  //
  // All five met the floor and none measured below it. The spread is zero,
  // which is the property being claimed: same figure, same two uncovered
  // lines, every run. Those two are handleRevealInFinder's macOS-only spawn,
  // which nothing covers on purpose either and which is carded separately.
  //
  // The interleaving that was failing measured 81/85 = 95.3%, with lines
  // 71-72 AND 81-82 of lib/protocol/handlers/files.js uncovered: the catch
  // and the reveal spawn missing together.
  // It cannot recur, because 71-72 no longer depends on another test
  // happening to make a create throw. The lcov confirms the mechanism rather
  // than just the total: line 71 was hit in all five runs, with the count
  // varying between 1 and 3, so the incidental hits still arrive, on top of
  // one that is now guaranteed. The worst case is therefore 83/85.
  //
  // DISCRIMINATION was proved by hand, and had to be. `npm run red-first`
  // returns NOT-PROVABLE for a change that is only a test, correctly: it
  // works by reverting the source, and there is no source here to take away.
  // So the mutation is the only evidence, and it is this one: delete the
  // `ws.send` inside that catch, leaving the catch itself in place, and
  // the suite reports 14 pass, 1 fail with this test the single failure.
  // Nothing else in the suite notices the send is gone, which is the whole
  // reason the floor was measuring luck.
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
          isWritableInWorkspace: (p) => path.resolve(p).startsWith(path.resolve(dir) + path.sep),
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

// A package import writes agent files, so it must tell the same cache
// cascade every other agent write tells: without that, the roster the
// server serves can predate the install until the cache expires or the
// person reloads, which makes a working install look like a failed one.
// Driven with the composition root's own context, so what is proven is the
// wired product: the real dispatch, the real handler, the real root
// cascade, and the real discovery cache the roster is read from.
describe('a package import invalidates the roster cache the way every other agent write does', () => {
  test('the roster read through the server right after an apply carries the imported agent, on a still-warm cache', () => {
    const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
    const table = buildDispatch();
    const original = config.getWorkspace();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-pkg-roster-'));
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-pkg-src-'));
    try {
      fs.mkdirSync(path.join(workspace, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(workspace, '.claude', 'agents', 'resident.md'), '---\nname: resident\n---\n\nAlready here.\n');
      fs.mkdirSync(path.join(sourceRoot, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, '.claude', 'agents', 'scribe.md'), '---\nname: scribe\n---\n\nWrite things.\n');
      config.setWorkspace(workspace);
      srv.invalidateAgentCache();
      // Warm the cache the way any client request does, so the read after
      // the apply is answered from cache unless the import invalidates it.
      // The platform guide rides on every roster, so membership is asserted
      // rather than the exact list.
      const before = srv.discoverAgents().map((a) => a.id);
      assert.ok(before.includes('resident') && !before.includes('scribe'),
        'fixture sanity: the roster is warm and the imported agent is not on it yet');
      const approval = decide(
        buildPlan(workspace, sourceRoot, { id: 'github.com/example/pack', reference: 'v1.0.0' }),
        { 'agent:scribe': 'add' },
      );
      const ws = captureWs();
      table.apply_package_import(srv.wsHandlerContext, ws,
        { type: 'apply_package_import', sourcePath: sourceRoot, approval });
      assert.strictEqual(ws.sent[0].type, 'package_import_result');
      assert.strictEqual(ws.sent[0].status, 'ready');
      assert.ok(srv.discoverAgents().map((a) => a.id).includes('scribe'),
        'the roster the server serves carries the imported agent immediately, with no reload and no cache expiry');
    } finally {
      config.setWorkspace(original);
      srv.invalidateAgentCache();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(sourceRoot, { recursive: true, force: true });
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
    const idle = { idle: true, exited: false, processId: 'p1', agentId: 'wren' };
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

// ===========================================================================
// WHICH WORKSPACE THE SCHEDULER IS SERVING, ANNOUNCED FROM ONE PLACE
// ===========================================================================
//
// There is one scheduler and it serves one workspace, and several windows can
// be looking at one server: a browser on the laptop and one on the phone,
// which is the setup the always-on documentation recommends. Only the socket
// that asked for a switch used to learn about it, so every other window went
// on drawing a next-run time against routines that had stopped being served.
//
// THE ANNOUNCE LIVES WHERE THE CHANGE HAPPENS, NOT WHERE IT WAS REQUESTED, and
// these tests are about the difference. setWorkspaceRoot is the one function
// that writes the root and points the scheduler at it, and its own comment
// already names the four ways a workspace changes: open one, create one, roll
// back to the previous one after a failed open, clear the pointer to one that
// has gone. Announced from the open handler instead, the notice described a
// root the server was not always serving, because the open path can throw
// after the announce and the rollback puts the old root back without saying
// so. Here the rollback IS a call to this function, so the retraction cannot
// be forgotten.
// The OS write block is NOT driven by workspace mode. It used to be, which is
// how choosing Code also turned off keeping agents inside the workspace; the
// switch is its own setting now (test/unit/sandbox-switch.test.js). These
// drive set_workspace_mode through the real dispatch table and prove it leaves
// the block alone on every platform.
describe('the OS write block is not driven by mode, through the real dispatch', () => {
  const workspace = require('../../lib/protocol/handlers/workspace.js');
  const scaffold = require('../../lib/workspace/scaffold.js');

  function withWorkspace(dir, fn) {
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    try { return fn(); } finally { config.setWorkspace(original); }
  }
  function tempWs() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-mode-'));
    fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
    return d;
  }
  const settingsBytes = (dir) => {
    try { return fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'); } catch (e) { return null; }
  };

  test('on macOS, switching mode back and forth never writes the settings file, with a block present or absent', () => {
    const table = buildDispatch();
    for (const seeded of [true, false]) {
      const dir = tempWs();
      if (seeded) {
        fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'),
          JSON.stringify({ sandbox: scaffold.sandboxSettings(dir, 'darwin') }, null, 2));
      }
      const before = settingsBytes(dir);
      withWorkspace(dir, () => {
        for (const mode of ['notes', 'code', 'code', 'notes', 'code']) {
          const socket = captureWs();
          table.set_workspace_mode({}, socket, { mode }, 'darwin');
          assert.deepStrictEqual(socket.sent[0], { type: 'workspace_mode_changed', mode });
          assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'state.json'), 'utf8')).workspaceMode, mode);
          assert.strictEqual(settingsBytes(dir), before, `${seeded ? 'with' : 'without'} a block, after ${mode}`);
        }
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('on a platform with no OS sandbox, mode persists and no block is ever written', () => {
    const table = buildDispatch();
    const dir = tempWs();
    withWorkspace(dir, () => {
      for (const mode of ['notes', 'code']) {
        table.set_workspace_mode({}, captureWs(), { mode }, 'linux');
        assert.strictEqual(settingsBytes(dir), null, `${mode} on Linux`);
      }
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // THE OLD STANDALONE MESSAGES STAY GONE. set_sandbox_mode and
  // get_sandbox_mode were removed when mode briefly owned the block; the switch
  // that replaced them has its own names, so a client (or a prompt-injected
  // instruction) sending the old ones still reaches no handler at all.
  test('the removed sandbox messages are still not messages the protocol recognises', () => {
    const table = buildDispatch();
    assert.strictEqual('set_sandbox_mode' in table, false);
    assert.strictEqual('get_sandbox_mode' in table, false);
  });

  test('a write the workspace refuses becomes a named error, never silence, and commits no mode', () => {
    // .rundock exists as a FILE, so the state write cannot happen and the
    // failure surfaces as a workspace_error carrying the cause.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-mode-bad-'));
    fs.writeFileSync(path.join(dir, '.rundock'), 'not a directory');
    withWorkspace(dir, () => {
      const set = captureWs();
      workspace.handleSetWorkspaceMode({}, set, { mode: 'code' }, 'darwin');
      assert.strictEqual(set.sent[0].type, 'workspace_error');
      assert.match(set.sent[0].message, /Could not update workspace mode/);
      assert.strictEqual(fs.readFileSync(path.join(dir, '.rundock'), 'utf8'), 'not a directory');
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the serving-workspace notice', () => {
  const { _internal: root } = require('../../server.js');
  // TWO WINDOWS, NOT ONE, and each with its own inbox. 'Tells every connected
  // window' is a claim about fan-out, and one listener satisfies it whether
  // the transport reaches everybody, the first socket, or the most recent
  // one. Two distinct clients are the smallest number a send-to-one
  // implementation cannot satisfy.
  let seenByWindow = [[], []];
  const listeners = [0, 1].map((i) => ({
    readyState: 1, send: (raw) => seenByWindow[i].push(JSON.parse(raw)),
  }));
  function listening(fn) {
    const before = [...root.connectedClients];
    const original = config.getWorkspace();
    seenByWindow = [[], []];
    root.connectedClients.clear();
    for (const l of listeners) root.connectedClients.add(l);
    try {
      return fn();
    } finally {
      root.connectedClients.clear();
      for (const c of before) root.connectedClients.add(c);
      root.setWorkspace(original);
    }
  }

  // THE SEAM BETWEEN THE HANDLER AND THE ANNOUNCER, bound rather than
  // assumed. The handler test above proves the handler adds no notice of its
  // own, and the tests below prove the root setter announces to every window;
  // what neither can see is the composition root handing the handler a setter
  // that does not announce, which would leave every window that did not ask
  // for a switch silently untold with both suites green. So the function the
  // handler actually receives, off the server's own composed context, is
  // driven here and required to announce to both windows.
  test('the setter the composed context hands the handler is the announcing one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serving-seam-'));
    try {
      listening(() => {
        const composed = root.wsHandlerContext.workspace.setWorkspaceRoot;
        composed(dir);
        const heard = eachWindowNotices();
        assert.strictEqual(heard[heard.length - 1] && heard[heard.length - 1].path, dir,
          'the setter the handler is composed with must be the one that tells every window, '
          + 'or a rewire of the composition root silently disconnects the notice');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Every assertion on one window's inbox is made of the other's too, so a
  // transport that reached only one socket fails on whichever it missed.
  function eachWindowNotices() {
    const per = seenByWindow.map(inbox => inbox.filter(m => m.type === 'serving_workspace'));
    assert.deepStrictEqual(per[0], per[1],
      'both connected windows hear the same notices in the same order, or the transport is picking favourites');
    return per[0];
  }

  const notices = () => eachWindowNotices();
  const lastNotice = () => notices()[notices().length - 1] || null;

  test('changing the root tells every connected window which workspace it is', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serving-'));
    try {
      listening(() => {
        const before = notices().length;
        root.setWorkspace(dir);
        assert.strictEqual(lastNotice() && lastNotice().path, dir,
          'a window that did not ask for the switch is told where the scheduler went');
        assert.strictEqual(notices().length, before + 1,
          'and exactly once per change: this is the composed wiring, so a second notice here is a second sender');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The state a window has never been told apart from the state it has been
  // told is nothing: a workspace whose folder has gone leaves the scheduler
  // serving none, and a window left describing the old one would go on
  // promising runs nothing can make.
  test('clearing the root says so rather than going quiet', () => {
    listening(() => {
      root.setWorkspace(null);
      assert.strictEqual(lastNotice() && lastNotice().path, null,
        'no workspace is a statement, not a silence');
    });
  });

  // THE FAILURE PATH, WHICH IS WHERE THE FIRST VERSION OF THIS INVERTED.
  //
  // The open path can throw after the root has already changed, and the
  // handler's catch puts the previous root back. Announced from the handler
  // before that work, every window was left believing the new workspace was
  // being served while the scheduler had returned to the old one, so windows
  // showing the old workspace's roster drew every firing routine as moved and
  // dormant, with nothing scheduled to correct it.
  test('an open that throws leaves the notice describing the workspace actually served', () => {
    const table = buildDispatch();
    const previous = fs.mkdtempSync(path.join(os.tmpdir(), 'serving-prev-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'serving-next-'));
    const noop = () => {};
    // Throws AFTER setWorkspaceRoot has run, which is the window this covers.
    const ctx = {
      signals: { phaseTimer: () => { throw new Error('prepare exploded'); } },
      runtime: { killAllChildren: noop },
      workspace: {
        setWorkspaceRoot: (d) => root.setWorkspace(d),
        armFileTreeWatcher: noop,
      },
      agents: { invalidateAgentCache: noop },
      store: { clearSearchFailure: noop },
    };
    try {
      listening(() => {
        root.setWorkspace(previous);
        const ws = captureWs();
        table.set_workspace(ctx, ws, { type: 'set_workspace', path: target });
        assert.strictEqual(ws.sent[0].type, 'workspace_error', 'sanity: the open path threw');
        assert.strictEqual(config.getWorkspace(), previous, 'sanity: the root was rolled back');
        assert.strictEqual(lastNotice() && lastNotice().path, previous,
          'the last thing every window was told is the workspace the scheduler is actually serving');
      });
    } finally {
      fs.rmSync(previous, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('standing tool allows outlive the tab they were given in', () => {
  const boundary = require('../../lib/workspace/boundary.js');

  function allowsWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-allows-'));
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    return dir;
  }

  test('an allow is stored, listed back, and survives a fresh read of the workspace', () => {
    // The defect: the set lived in the browser tab, so a reload silently
    // withdrew every answer and the card asked again. Asserted by reading the
    // store back through a separate call rather than by trusting the reply,
    // because the reply could be right while nothing was written.
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = allowsWorkspace();
    try {
      config.setWorkspace(dir);
      const ws = captureWs();
      table.add_tool_allow({}, ws, { type: 'add_tool_allow', key: 'Bash:git' });
      assert.strictEqual(ws.sent[0].type, 'tool_allows');
      assert.deepStrictEqual(ws.sent[0].tools, ['Bash:git']);
      assert.deepStrictEqual(boundary.readToolAllows(), ['Bash:git'],
        'and it is on disk, which is what a reload will read');
    } finally { config.setWorkspace(original); }
  });

  // WHAT MAY BECOME A STORED ANSWER, decided at the wire rather than at the
  // renderer. The client only ever builds bare identifiers (a tool name, or
  // `Bash:<binary>` with directories already stripped), but the client is not
  // the only thing that can send this message, and anything stored here is
  // later rendered into a settings row. The renderer defends itself too; this
  // is the other half of that pair, and it is the half that keeps the stored
  // set clean rather than merely survivable.
  test('a key that is not a tool name is refused, and nothing is stored', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = allowsWorkspace();
    try {
      config.setWorkspace(dir);
      const hostile = [
        "x'); alert('pwned",      // closes a JavaScript literal
        '<script>alert(1)</script>',
        'Bash:git; rm -rf /',     // whitespace and a shell operator
        'Bash:git\nBash:rm',      // a newline, so one row could become two
        '../../etc/passwd',
        'a'.repeat(129),          // longer than any real tool name
      ];
      for (const key of hostile) {
        const ws = captureWs();
        table.add_tool_allow({}, ws, { type: 'add_tool_allow', key });
        assert.strictEqual(ws.sent[0].type, 'tool_allow_failed',
          `refused rather than stored: ${JSON.stringify(key)}`);
      }
      assert.deepStrictEqual(boundary.readToolAllows(), [],
        'not one of them reached the store');

      // The other direction, so the rule cannot be satisfied by refusing
      // everything: the keys the client actually builds are all accepted.
      for (const key of ['Bash:git', 'Bash:npm', 'PowerShell:Get-Item', 'WebFetch', 'Bash:docker-compose']) {
        const ws = captureWs();
        table.add_tool_allow({}, ws, { type: 'add_tool_allow', key });
        assert.strictEqual(ws.sent[0].type, 'tool_allows',
          `a key the permission card can produce must be accepted: ${key}`);
      }
      assert.strictEqual(boundary.readToolAllows().length, 5);
    } finally { config.setWorkspace(original); }
  });

  test('a grant is scoped to the workspace it was given in', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const a = allowsWorkspace();
    const b = allowsWorkspace();
    try {
      config.setWorkspace(a);
      table.add_tool_allow({}, captureWs(), { type: 'add_tool_allow', key: 'Bash:npm' });
      config.setWorkspace(b);
      const other = captureWs();
      table.get_tool_allows({}, other, { type: 'get_tool_allows' });
      assert.deepStrictEqual(other.sent[0].tools, [],
        'another workspace is unaffected: these are never machine-wide');
    } finally { config.setWorkspace(original); }
  });

  test('revoking takes effect immediately, and revoking something absent is not an error', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = allowsWorkspace();
    try {
      config.setWorkspace(dir);
      table.add_tool_allow({}, captureWs(), { type: 'add_tool_allow', key: 'Bash:curl' });
      const after = captureWs();
      table.remove_tool_allow({}, after, { type: 'remove_tool_allow', key: 'Bash:curl' });
      assert.deepStrictEqual(after.sent[0].tools, []);
      assert.deepStrictEqual(boundary.readToolAllows(), [], 'gone from the store, not just the reply');
      // Clicking revoke twice is a person being decisive, not an error.
      const again = captureWs();
      table.remove_tool_allow({}, again, { type: 'remove_tool_allow', key: 'Bash:curl' });
      assert.strictEqual(again.sent[0].type, 'tool_allows');
    } finally { config.setWorkspace(original); }
  });

  test('an unreadable store means no standing answer, never a silent yes', () => {
    // THE DIRECTION THAT MATTERS. A corrupt file must make the card appear, not
    // make a request pass. Anything else turns a damaged file into consent.
    const original = config.getWorkspace();
    const dir = allowsWorkspace();
    try {
      config.setWorkspace(dir);
      fs.writeFileSync(path.join(dir, '.rundock', 'permissions.json'), '{ not json');
      assert.deepStrictEqual(boundary.readToolAllows(), [],
        'unreadable reads as nothing allowed, so the person is asked again');
    } finally { config.setWorkspace(original); }
  });

  test('with no workspace open, reading answers empty and writing is refused', () => {
    // The same split the working folders take, for the same reason: asking what
    // is allowed before a workspace is open is a fair question with a true
    // answer, while GRANTING one has nowhere to be recorded and must say so
    // rather than appear to succeed.
    const table = buildDispatch();
    const original = config.getWorkspace();
    try {
      config.setWorkspace(null);
      const reader = captureWs();
      table.get_tool_allows({}, reader, { type: 'get_tool_allows' });
      assert.deepStrictEqual(reader.sent[0], { type: 'tool_allows', tools: [] });

      const writer = captureWs();
      table.add_tool_allow({}, writer, { type: 'add_tool_allow', key: 'Bash:git' });
      assert.strictEqual(writer.sent[0].type, 'tool_allow_failed');
      assert.match(writer.sent[0].message, /Open a workspace/);

      // Revoking without a workspace answers the empty list rather than
      // erroring: there is nothing to revoke and nothing was promised.
      const revoker = captureWs();
      table.remove_tool_allow({}, revoker, { type: 'remove_tool_allow', key: 'Bash:git' });
      assert.deepStrictEqual(revoker.sent[0], { type: 'tool_allows', tools: [] });
    } finally { config.setWorkspace(original); }
  });

  test('an allow with no key named is refused, not recorded as an empty string', () => {
    const table = buildDispatch();
    const original = config.getWorkspace();
    const dir = allowsWorkspace();
    try {
      config.setWorkspace(dir);
      const ws = captureWs();
      table.add_tool_allow({}, ws, { type: 'add_tool_allow' });
      assert.strictEqual(ws.sent[0].type, 'tool_allow_failed');
      assert.match(ws.sent[0].message, /no tool was named/);
      assert.deepStrictEqual(boundary.readToolAllows(), [],
        'and nothing was written, so no card is silenced by a blank key');
    } finally { config.setWorkspace(original); }
  });

  test('storing a tool allow leaves the folder grants alone', () => {
    // They share a file. A writer that rebuilt it from its own half would drop
    // the other, silently withdrawing folder access the person had granted.
    const original = config.getWorkspace();
    const dir = allowsWorkspace();
    try {
      config.setWorkspace(dir);
      boundary.addBoundaryGrant(path.join(dir, 'somewhere'));
      const before = boundary.readBoundaryGrants();
      assert.strictEqual(before.length, 1, 'fixture sanity: a folder grant exists');
      boundary.addToolAllow('Bash:git');
      assert.deepStrictEqual(boundary.readBoundaryGrants(), before,
        'the folder grant survives a tool allow being written beside it');
      boundary.removeToolAllow('Bash:git');
      assert.deepStrictEqual(boundary.readBoundaryGrants(), before,
        'and survives one being revoked');
    } finally { config.setWorkspace(original); }
  });
});
