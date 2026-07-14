'use strict';
// Integration: Windows Codex write-request markers (Option F), end to end
// against the codex stub with the platform seam forcing win32 behaviour.
// The Codex CLI cannot enforce its write sandbox on native Windows, so
// win32 codex spawns are instructed to emit WRITE_FILE markers; the server
// validates each request, raises a permission card, and performs approved
// writes itself. Companion in codex-chat.test.js pins that non-Windows
// spawns get neither the instruction nor marker handling.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

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

const MARKER = (p, c) => `<!-- RUNDOCK:WRITE_FILE path="${p}" -->\n${c}\n<!-- /RUNDOCK:WRITE_FILE -->`;

before(async () => {
  await h.boot({ agents: team(), env: { RUNDOCK_TEST_PLATFORM: 'win32' } });
  client = await h.connect();
});
after(async () => h.shutdown());

function transcript(convoId) {
  return JSON.parse(fs.readFileSync(path.join(h.workspaceDir, '.rundock', 'transcripts', `${convoId}.json`), 'utf-8'));
}

describe('codex write markers on win32', () => {
  test('first-turn prompt carries the WINDOWS FILE WRITES instruction', async () => {
    const convoId = h.freshConvoId('cwm');
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'plain question' }, text: 'Plain answer.' }]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'plain question' });
    await client.waitForEvent('system', 'done', convoId);
    const inv = h.readInvocations().find(i => i.argv && i.argv[0] === 'exec');
    assert.ok(inv.prompt.includes('WINDOWS FILE WRITES'), 'marker instruction in first-turn prompt');
    assert.ok(inv.prompt.includes('RUNDOCK:WRITE_FILE'), 'format example included');
    h.reapConvo(convoId);
  });

  test('approved write: card raised, exact bytes on disk, marker stripped from the displayed result', async () => {
    const convoId = h.freshConvoId('cwm');
    h.clearInvocations();
    const content = '# Synthesis\n\nTheme: systems earn value through use.';
    h.writeCodexScenario([{
      match: { promptIncludes: 'write the synthesis' },
      text: `I prepared the file.\n\n${MARKER('Research Notes/Synthesis.md', content)}`,
    }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'write the synthesis please' });

    // Result arrives with the marker replaced by the plain-language line
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'clean result' });
    assert.ok(!result.result.includes('RUNDOCK:WRITE_FILE'), 'marker stripped');
    assert.ok(result.result.includes('[write requested: Research Notes/Synthesis.md]'));

    // Card arrives AFTER the result, as a WriteFile control_request
    const { msg: card } = await client.waitFor(m => m.type === 'control_request' && m._conversationId === convoId, { label: 'write card' });
    assert.strictEqual(card.request.tool_name, 'WriteFile');
    assert.strictEqual(card.request.input.path, 'Research Notes/Synthesis.md');
    assert.strictEqual(card.request.input.content, content);

    // Approve: exact bytes land on disk, confirmation pill + file_saved fire
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: true });
    await client.waitFor(m => m.type === 'file_saved' && m.path === 'Research Notes/Synthesis.md', { label: 'file saved' });
    const onDisk = fs.readFileSync(path.join(h.workspaceDir, 'Research Notes', 'Synthesis.md'), 'utf-8');
    assert.strictEqual(onDisk, content, 'byte-exact write');
    const t = transcript(convoId);
    assert.ok(t.find(e => e.text === 'Created Research Notes/Synthesis.md (approved).'));

    h.reapConvo(convoId);
  });

  test('denied write: no file, refusal recorded in the transcript', async () => {
    const convoId = h.freshConvoId('cwm');
    h.clearInvocations();
    h.writeCodexScenario([{
      match: { promptIncludes: 'write denied-note' },
      text: MARKER('denied-note.md', 'should never land'),
    }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'write denied-note please' });
    const { msg: card } = await client.waitFor(m => m.type === 'control_request' && m._conversationId === convoId, { label: 'write card' });
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: false });

    // Deny is user-visible as a notice pill (event-driven signal)
    await client.waitFor(m => m.type === 'system' && m.subtype === 'notice' && m._conversationId === convoId && /not approved/.test(m.content || ''), { label: 'deny notice' });
    assert.ok(!fs.existsSync(path.join(h.workspaceDir, 'denied-note.md')), 'no file on deny');
    assert.ok(transcript(convoId).some(e => e.text === 'Write of denied-note.md not approved.'), 'deny recorded for the resumed thread');

    h.reapConvo(convoId);
  });

  test('traversal request is refused without a card', async () => {
    const convoId = h.freshConvoId('cwm');
    h.clearInvocations();
    h.writeCodexScenario([{
      match: { promptIncludes: 'write escape' },
      text: MARKER('../escape.md', 'outside'),
    }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'write escape please' });
    const { msg: info } = await client.waitFor(m => m.type === 'system' && m.subtype === 'notice' && m._conversationId === convoId && /Refused a file write/.test(m.content || ''), { since, label: 'refusal pill' });
    assert.match(info.content, /escapes the workspace/);
    // No card was ever raised for it
    const cards = client.messages.slice(since).filter(m => m.type === 'control_request' && m._conversationId === convoId);
    assert.deepStrictEqual(cards, []);
    assert.ok(!fs.existsSync(path.join(h.workspaceDir, '..', 'escape.md')), 'nothing written outside');

    h.reapConvo(convoId);
  });

  test('two markers in one turn produce two cards; each resolves independently', async () => {
    const convoId = h.freshConvoId('cwm');
    h.clearInvocations();
    h.writeCodexScenario([{
      match: { promptIncludes: 'write both' },
      text: `${MARKER('one.md', 'first')}\n${MARKER('two.md', 'second')}`,
    }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'write both please' });
    const { msg: cardA } = await client.waitFor(m => m.type === 'control_request' && m._conversationId === convoId && m.request.input.path === 'one.md', { label: 'card one' });
    const { msg: cardB } = await client.waitFor(m => m.type === 'control_request' && m._conversationId === convoId && m.request.input.path === 'two.md', { label: 'card two' });

    client.send({ type: 'permission_response', requestId: cardA.request_id, conversationId: convoId, allow: true });
    client.send({ type: 'permission_response', requestId: cardB.request_id, conversationId: convoId, allow: false });

    await client.waitFor(m => m.type === 'file_saved' && m.path === 'one.md', { label: 'first saved' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'notice' && m._conversationId === convoId && /two\.md was not approved/.test(m.content || ''), { label: 'second denied' });
    assert.ok(transcript(convoId).some(e => e.text === 'Write of two.md not approved.'));
    assert.strictEqual(fs.readFileSync(path.join(h.workspaceDir, 'one.md'), 'utf-8'), 'first');
    assert.ok(!fs.existsSync(path.join(h.workspaceDir, 'two.md')));

    h.reapConvo(convoId);
  });
});
