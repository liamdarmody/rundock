'use strict';
// Integration: on Windows WITH a [windows] sandbox declared in the Codex
// config, the CLI grants a real workspace-write policy and writes directly
// (verified live), so the write-marker fallback must stand down entirely:
// no instruction in the prompt, markers pass through as literal text, no
// permission card. Companion files: codex-write-markers.test.js (win32
// WITHOUT the config: markers active) and codex-chat.test.js (non-Windows:
// always inert).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

// A codex home whose config declares the native Windows sandbox. Created
// before boot so the server's per-spawn check sees it from turn one.
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n');

function team() {
  return {
    ...standardTeam(),
    'researcher': agentFile({
      name: 'researcher', displayName: 'Ida', role: 'Researcher',
      description: 'Researches suppliers', type: 'specialist', order: 5,
      reportsTo: 'chief-of-staff', runtime: 'codex',
      body: 'You are Ida, the researcher.',
    }),
  };
}

before(async () => {
  await h.boot({ agents: team(), env: { RUNDOCK_TEST_PLATFORM: 'win32', CODEX_HOME: codexHome } });
  client = await h.connect();
});
after(async () => {
  await h.shutdown();
  try { fs.rmSync(codexHome, { recursive: true, force: true }); } catch (e) {}
});

describe('codex on win32 with the native sandbox configured', () => {
  test('marker fallback stands down: no instruction, literal pass-through, no card', async () => {
    const convoId = h.freshConvoId('csc');
    h.clearInvocations();
    const markerText = '<!-- RUNDOCK:WRITE_FILE path="x.md" -->\nhello\n<!-- /RUNDOCK:WRITE_FILE -->';
    h.writeCodexScenario([{ match: { promptIncludes: 'sandboxed question' }, text: markerText }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'sandboxed question please' });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'result' });
    assert.strictEqual(result.result, markerText, 'marker text untouched when the sandbox is declared');
    await client.waitForEvent('system', 'done', convoId);

    const inv = h.readInvocations().find(i => i.argv && i.argv[0] === 'exec');
    assert.ok(!inv.prompt.includes('WINDOWS FILE WRITES'), 'no marker instruction when the sandbox is declared');
    const cards = client.messages.slice(since).filter(m => m.type === 'control_request' && m._conversationId === convoId);
    assert.deepStrictEqual(cards, [], 'no permission card');

    h.reapConvo(convoId);
  });

  test('runtime status reports the sandbox declaration', async () => {
    client.send({ type: 'get_runtime_status' });
    const { msg: status } = await client.waitFor(m => m.type === 'runtime_status', { label: 'runtime status' });
    // The codex stub is on PATH and the fake auth home has no auth.json;
    // what matters here is the windowsSandbox field derived from config.toml.
    assert.strictEqual(status.codex.windowsSandbox, true);
  });
});
