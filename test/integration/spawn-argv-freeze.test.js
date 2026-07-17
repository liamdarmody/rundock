'use strict';
// Argv freeze: pins the EXACT command line Rundock uses to spawn Claude Code
// processes, for every reachable spawn path.
//
// Why this exists: the spawn path is safety-critical (permission modes, tool
// allow/deny lists, sandbox posture all travel through argv) and it is about
// to grow a second runtime behind an internal seam. Any refactor that changes
// how Claude Code is invoked, even by reordering flags, must be a deliberate,
// reviewed decision that updates this file, never an accident.
//
// How it works: the stub binary records every invocation's full argv to
// stub-invocations.jsonl. Each test drives a real flow, then asserts the
// complete argv array against an explicit expectation. Values that are
// legitimately dynamic (workspace paths, system prompt bodies, session ids)
// are masked to a `<flag>` placeholder; everything else is asserted verbatim.
//
// If you changed the spawn path on purpose: update the expected arrays here
// in the same commit, and say why in the commit message.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

before(async () => {
  await h.boot({
    agents: {
      ...standardTeam(),
      // For the codex spawn freeze below.
      'codex-freeze': agentFile({
        name: 'codex-freeze', displayName: 'Frost', role: 'Frozen',
        description: 'Pins the codex spawn', type: 'specialist', order: 9,
        reportsTo: 'chief-of-staff', runtime: 'codex',
        body: 'You are Frost.',
      }),
    },
  });
  client = await h.connect();
});
after(async () => h.shutdown());

// Flags whose values are dynamic by design. The flag's presence and position
// stay frozen; only the value is masked.
const DYNAMIC_VALUE_FLAGS = new Set([
  '--add-dir', '--settings', '--mcp-config', '--append-system-prompt', '--resume',
]);

function maskArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    out.push(argv[i]);
    if (DYNAMIC_VALUE_FLAGS.has(argv[i]) && i + 1 < argv.length) {
      out.push(`<${argv[i].slice(2)}>`);
      i++;
    }
  }
  return out;
}

// These two strings are part of the product's permission posture. If either
// changes, that is a permissions change and must be reviewed as one.
const ALLOWED_TOOLS_INTERACTIVE = 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,ToolSearch,Agent,Skill';
const DISALLOWED_TOOLS_KNOWLEDGE = 'Write(*.js),Write(*.jsx),Write(*.ts),Write(*.tsx),Write(*.py),Write(*.sh),Write(*.bash),Write(*.rb),Write(*.pl),Write(*.exe),Write(*.dll),Write(*.so),Edit(*.js),Edit(*.jsx),Edit(*.ts),Edit(*.tsx),Edit(*.py),Edit(*.sh),Edit(*.bash),Edit(*.rb),Edit(*.pl),Edit(*.exe)';

describe('spawn argv freeze', () => {
  test('precondition: server startup scaffolds the permission hook settings; no .mcp.json', () => {
    // scaffoldWorkspace() runs inside startServer() and writes the PreToolUse
    // permission hook into .claude/settings.local.json, so --settings is part
    // of every spawn in a running server. .mcp.json is user-provided and absent.
    assert.ok(fs.existsSync(path.join(h.workspaceDir, '.claude', 'settings.local.json')));
    assert.ok(!fs.existsSync(path.join(h.workspaceDir, '.mcp.json')));
  });

  test('interactive chat spawn: full argv frozen', async () => {
    const convoId = h.freshConvoId('frz');
    h.clearInvocations();
    h.writeScenario([{ match: { agent: 'lead-designer' }, turn: [{ text: 'frozen.' }] }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'freeze interactive path' });
    await client.waitForEvent('system', 'done', convoId);

    const inv = h.readInvocations();
    assert.strictEqual(inv.length, 1, 'exactly one spawn');
    assert.deepStrictEqual(maskArgv(inv[0].argv), [
      '--add-dir', '<add-dir>',
      '--settings', '<settings>',
      '--model', 'sonnet',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--allowed-tools', ALLOWED_TOOLS_INTERACTIVE,
      '--disallowed-tools', DISALLOWED_TOOLS_KNOWLEDGE,
      '--append-system-prompt', '<append-system-prompt>',
      '--agent', 'lead-designer',
    ]);
    // Environment contract for spawned processes
    assert.strictEqual(inv[0].env.RUNDOCK, '1');
    assert.strictEqual(inv[0].env.RUNDOCK_CONVO_ID, convoId);
    assert.ok(inv[0].env.RUNDOCK_PORT, 'RUNDOCK_PORT set');
  });

  test('delegation delegate spawn: full argv frozen', async () => {
    const convoId = h.freshConvoId('frz');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'freeze delegate path' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'freeze delegate brief' } }],
      },
      {
        match: { agent: 'content-lead', promptIncludes: 'freeze delegate brief' },
        turn: [{ text: 'delegate frozen.' }],
      },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'freeze delegate path' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead',
      { label: 'delegate result' });

    const delegateInv = h.readInvocations().find(i => i.agent === 'content-lead');
    assert.ok(delegateInv, 'delegate spawn recorded');
    assert.deepStrictEqual(maskArgv(delegateInv.argv), [
      '--add-dir', '<add-dir>',
      '--settings', '<settings>',
      '--model', 'sonnet',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--allowed-tools', ALLOWED_TOOLS_INTERACTIVE,
      '--disallowed-tools', DISALLOWED_TOOLS_KNOWLEDGE,
      '--append-system-prompt', '<append-system-prompt>',
      '--agent', 'content-lead',
    ]);

    h.reapConvo(convoId);
  });

  test('routine spawn: full argv frozen (print mode, prompt as positional)', async () => {
    h.clearInvocations();
    h.writeScenario([{ match: {}, turn: [{ text: 'routine frozen.' }] }]);

    const agents = h.internal.discoverAgents();
    const agent = agents.find(a => a.id === 'content-lead');
    assert.ok(agent, 'fixture agent present');
    h.internal.executeRoutine(agent, { name: 'freeze-check', schedule: 'daily 09:00', prompt: 'freeze routine path' }, 'freeze-key');

    // The routine process exits on its own (print mode). Poll for the record.
    let inv = [];
    for (let i = 0; i < 40 && inv.length === 0; i++) {
      await h.delay(100);
      inv = h.readInvocations();
    }
    assert.strictEqual(inv.length, 1, 'exactly one routine spawn');
    assert.deepStrictEqual(maskArgv(inv[0].argv), [
      '--add-dir', '<add-dir>',
      '--settings', '<settings>',
      '--model', 'sonnet',
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--agent', 'content-lead',
      'freeze routine path',
    ]);
  });

  test('codex app-server spawn: full argv frozen and thread policy invariants pinned', async () => {
    // The Codex runtime runs on ONE shared `codex app-server` process; its
    // argv is the bare subcommand (everything else travels over the
    // protocol) and the safety posture rides thread/start params instead:
    // sandboxed workspace-write, per-action approvals to the USER, never a
    // danger mode, never the experimental protocol surface.
    const convoId = h.freshConvoId('frz');
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'freeze codex path' }, text: 'codex frozen.' }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'codex-freeze', content: 'freeze codex path' });
    await client.waitForEvent('system', 'done', convoId);

    const inv = h.readInvocations().filter(i => i.mode === 'app-server');
    const spawns = inv.filter(i => i.event === 'spawn');
    assert.strictEqual(spawns.length, 1, 'exactly one app-server spawn');
    assert.deepStrictEqual(spawns[0].argv, ['app-server']);

    const init = inv.find(i => i.method === 'initialize');
    assert.strictEqual(init.params.capabilities.experimentalApi, false, 'stable protocol surface only');

    const starts = inv.filter(i => i.method === 'thread/start');
    assert.strictEqual(starts.length, 1, 'one thread for the turn');
    assert.strictEqual(starts[0].params.sandbox, 'workspace-write');
    assert.strictEqual(starts[0].params.approvalPolicy, 'on-request');
    assert.strictEqual(starts[0].params.approvalsReviewer, 'user');

    // Belt and braces: no danger mode anywhere on the wire.
    for (const e of inv) {
      assert.ok(!JSON.stringify(e).includes('danger'), `danger mode leaked: ${JSON.stringify(e).slice(0, 120)}`);
    }
  });
});
