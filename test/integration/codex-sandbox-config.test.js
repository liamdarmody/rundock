'use strict';
// Integration: Windows sandbox reporting after the write-marker retirement.
// hasWindowsSandboxConfig stays (Settings uses it to explain whether Codex
// writes run silently inside the native sandbox or arrive as per-action
// approval cards), but the marker behaviour it used to gate is GONE: no
// prompt instruction on any platform, and marker-shaped output passes
// through as literal text. This file pins both halves with the win32
// platform seam active and a [windows] sandbox declared.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

// A codex home whose config declares the native Windows sandbox. Created
// before boot so runtime detection sees it from the first status render.
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
  test('no marker instruction in any prompt; marker-shaped text passes through; no card', async () => {
    const convoId = h.freshConvoId('csc');
    h.clearInvocations();
    const markerText = '<!-- RUNDOCK:WRITE_FILE path="x.md" -->\nhello\n<!-- /RUNDOCK:WRITE_FILE -->';
    h.writeCodexScenario([{ match: { promptIncludes: 'sandboxed question' }, text: markerText }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'sandboxed question please' });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'result' });
    assert.strictEqual(result.result, markerText, 'marker text untouched: the marker mechanism is retired');
    await client.waitForEvent('system', 'done', convoId);

    const prompts = h.codexTurnPrompts();
    assert.strictEqual(prompts.length, 1, 'one turn recorded');
    assert.ok(!prompts[0].includes('WINDOWS FILE WRITES'), 'no marker instruction in the prompt');
    assert.ok(!prompts[0].includes('RUNDOCK:WRITE_FILE'), 'no marker format taught to the agent');
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
