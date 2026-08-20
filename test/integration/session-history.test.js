'use strict';
// Characterisation: the get_session_history WS handler, pinned as it behaves
// today, before it moves out of server.js.
//
// The handler has two modes. With `sessionIds`, it merges JSONL content from
// every session the conversation touched, using the Rundock transcript as the
// ordering and attribution authority (JSONL sessions group messages
// per-process and reorder across agents). Without `sessionIds`, it falls back
// to reading a single session directly. These tests seed both sources on disk
// exactly where production reads them: session JSONL under
// $HOME/.claude/projects/<workspace-hash>/, transcripts under
// .rundock/transcripts/.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');

let client;
let sessionsDir;

function writeSession(sessionId, entries) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), lines);
}

function userLine(content, timestamp) {
  return { type: 'user', message: { role: 'user', content }, timestamp: timestamp || null };
}

function assistantLine(text, timestamp) {
  return { message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: timestamp || null };
}

function toolLine(name, timestamp) {
  return { message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] }, timestamp: timestamp || null };
}

function writeTranscript(convoId, entries) {
  const dir = path.join(h.workspaceDir, '.rundock', 'transcripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${convoId}.json`), JSON.stringify(entries, null, 2));
}

function getHistory(msg, label) {
  const since = client.messages.length;
  client.send({ type: 'get_session_history', ...msg });
  return client.waitFor(
    m => m.type === 'session_history' && m.conversationId === msg.conversationId,
    { since, label: label || `session_history for ${msg.conversationId}` }
  ).then(r => r.msg);
}

before(async () => {
  await h.boot();
  client = await h.connect();
  // Production derives the JSONL directory name from the workspace path with
  // slashes turned into dashes. Pin that derivation by using it.
  sessionsDir = path.join(process.env.HOME, '.claude', 'projects', h.workspaceDir.replace(/\//g, '-'));
});
after(async () => h.shutdown());

describe('get_session_history: multi-session merge', () => {
  test('the transcript orders and attributes; JSONL supplies full content', async () => {
    const convoId = 'sh-merge-1';
    // Orchestrator session: greeted, then routed.
    writeSession('sess-orch-1', [
      userLine('Hello there team', '2026-08-11T10:00:00Z'),
      assistantLine('Routing you to the specialist for this request', '2026-08-11T10:00:05Z'),
    ]);
    // Specialist session: the transcript stores only a prefix of this reply;
    // the JSONL carries the full text, and the merge must prefer it.
    const fullReply = 'Here is the draft you asked for, complete with the long tail of content that the transcript truncated away.';
    writeSession('sess-spec-1', [
      assistantLine(fullReply, '2026-08-11T10:01:00Z'),
    ]);
    writeTranscript(convoId, [
      { role: 'user', text: 'Hello there team', timestamp: '2026-08-11T10:00:00Z' },
      { role: 'agent', agent: 'chief-of-staff', text: 'Routing you to the specialist for this request', timestamp: '2026-08-11T10:00:05Z' },
      { role: 'agent', agent: 'penn', text: 'Here is the draft you asked for, complete with the long', timestamp: '2026-08-11T10:01:00Z' },
    ]);

    const res = await getHistory({
      conversationId: convoId,
      sessionIds: [{ sessionId: 'sess-orch-1' }, { sessionId: 'sess-spec-1' }],
    });

    assert.strictEqual(res.totalCount, 3);
    assert.strictEqual(res.hasMore, false);
    assert.deepStrictEqual(res.messages.map(m => [m.role, m.agentId]), [
      ['user', null],
      ['assistant', 'chief-of-staff'],
      ['assistant', 'penn'],
    ]);
    // Full JSONL content won over the transcript's truncated prefix.
    assert.strictEqual(res.messages[2].content, fullReply);
  });

  test('routing entries pass through typed, so the client can draw the divider without a bubble', async () => {
    const convoId = 'sh-routing-1';
    writeSession('sess-routing-1', [userLine('Route this please', null)]);
    writeTranscript(convoId, [
      { role: 'user', text: 'Route this please' },
      { role: 'agent', agent: 'chief-of-staff', text: '', type: 'routing', timestamp: '2026-08-11T11:00:00Z' },
      { role: 'agent', agent: 'penn', text: 'Specialist reporting in' },
    ]);

    const res = await getHistory({ conversationId: convoId, sessionIds: [{ sessionId: 'sess-routing-1' }] });

    const routing = res.messages.find(m => m.type === 'routing');
    assert.ok(routing, 'routing entry present in merged history');
    assert.strictEqual(routing.role, 'assistant');
    assert.strictEqual(routing.agentId, 'chief-of-staff');
    // The specialist turn had no JSONL match: transcript text is used rather
    // than the turn being dropped.
    assert.strictEqual(res.messages.at(-1).content, 'Specialist reporting in');
  });

  test('a JSONL reply shorter than its transcript entry still matches (prefix containment runs both ways)', async () => {
    const convoId = 'sh-shortmatch-1';
    // The transcript entry carries trailing text the JSONL does not (e.g. the
    // transcript writer appended tool summaries after the prose).
    writeSession('sess-shortmatch-1', [assistantLine('Short answer', null)]);
    writeTranscript(convoId, [
      { role: 'agent', agent: 'chief-of-staff', text: 'Short answer with trailing transcript-only text appended after the prose' },
    ]);

    const res = await getHistory({ conversationId: convoId, sessionIds: [{ sessionId: 'sess-shortmatch-1' }] });

    assert.strictEqual(res.messages.length, 1);
    assert.strictEqual(res.messages[0].content, 'Short answer');
    assert.strictEqual(res.messages[0].agentId, 'chief-of-staff');
  });

  test('repeated user messages in the transcript collapse to one bubble', async () => {
    const convoId = 'sh-dedup-1';
    writeSession('sess-dedup-1', [userLine('Say that again', null)]);
    // A resume replays the user message into the transcript twice.
    writeTranscript(convoId, [
      { role: 'user', text: 'Say that again' },
      { role: 'user', text: 'Say that again' },
      { role: 'agent', agent: 'chief-of-staff', text: 'Only once, though' },
    ]);

    const res = await getHistory({ conversationId: convoId, sessionIds: [{ sessionId: 'sess-dedup-1' }] });

    assert.strictEqual(res.messages.filter(m => m.role === 'user').length, 1);
    assert.strictEqual(res.totalCount, 2);
  });

  test('internal injection messages never become bubbles: briefs, system markers, resume ghosts', async () => {
    const convoId = 'sh-filter-1';
    writeSession('sess-filter-1', [
      userLine('[DELEGATION BRIEF] internal handoff payload', null),
      userLine('[SYSTEM: scope return] internal marker', null),
      userLine('CONVERSATION SO FAR: transcript replay', null),
      assistantLine('No response requested.', null),
      userLine('The one real user message', null),
      assistantLine('The one real reply', null),
    ]);

    // No transcript: the JSONL pool IS the history, so the pool filters are
    // observable directly.
    const res = await getHistory({ conversationId: convoId, sessionIds: [{ sessionId: 'sess-filter-1' }] });

    assert.deepStrictEqual(res.messages.map(m => m.content), [
      'The one real user message',
      'The one real reply',
    ]);
    assert.strictEqual(res.totalCount, 2);
  });

  test('pagination slices from the end: limit and offset window the merged history', async () => {
    const convoId = 'sh-page-1';
    const entries = [];
    for (let i = 1; i <= 6; i++) entries.push(userLine(`Message number ${i}`, null));
    writeSession('sess-page-1', entries);

    const page1 = await getHistory({ conversationId: convoId, sessionIds: [{ sessionId: 'sess-page-1' }], limit: 2 });
    assert.deepStrictEqual(page1.messages.map(m => m.content), ['Message number 5', 'Message number 6']);
    assert.strictEqual(page1.totalCount, 6);
    assert.strictEqual(page1.hasMore, true);

    const page2 = await getHistory({ conversationId: convoId, sessionIds: [{ sessionId: 'sess-page-1' }], limit: 2, offset: 2 });
    assert.deepStrictEqual(page2.messages.map(m => m.content), ['Message number 3', 'Message number 4']);

    const lastPage = await getHistory({ conversationId: convoId, sessionIds: [{ sessionId: 'sess-page-1' }], limit: 2, offset: 4 });
    assert.deepStrictEqual(lastPage.messages.map(m => m.content), ['Message number 1', 'Message number 2']);
    assert.strictEqual(lastPage.hasMore, false);
  });

  test('a missing session file degrades to the transcript, not an error', async () => {
    const convoId = 'sh-missing-1';
    writeTranscript(convoId, [
      { role: 'user', text: 'Anyone home' },
      { role: 'agent', agent: 'chief-of-staff', text: 'Recovered from the transcript alone' },
    ]);

    const res = await getHistory({ conversationId: convoId, sessionIds: [{ sessionId: 'sess-does-not-exist' }] });

    assert.deepStrictEqual(res.messages.map(m => m.content), [
      'Anyone home',
      'Recovered from the transcript alone',
    ]);
  });

  test('every text block of a multi-block turn survives a relaunch', async () => {
    // The shape from the field report: text, tool, text, tool, text. It renders
    // in full while live and, before this was fixed, collapsed to its opening
    // line on reload. The session file kept every block; the rebuild claimed
    // one of them per turn and silently dropped the rest, so the final summary,
    // usually the most valuable part of a long turn, vanished from view.
    const convoId = 'sh-multiblock-1';
    const first = 'Let me gather the actual clutter before prescribing anything.';
    const second = 'Now checking what the settings file already carries.';
    const third = "I've done everything that was safe to do without your input. "
      + 'Here is the summary and what I recommend next, which is the part worth keeping.';

    writeSession('sess-multi-1', [
      userLine('Please tidy this workspace', '2026-08-13T09:00:00Z'),
      assistantLine(first, '2026-08-13T09:00:10Z'),
      toolLine('Read', '2026-08-13T09:00:11Z'),
      assistantLine(second, '2026-08-13T09:00:20Z'),
      toolLine('Edit', '2026-08-13T09:00:21Z'),
      assistantLine(third, '2026-08-13T09:00:30Z'),
    ]);
    // One transcript entry per TURN, holding the turn's whole text, which is
    // what the accumulator in the delegation engine produces.
    writeTranscript(convoId, [
      { role: 'user', text: 'Please tidy this workspace', timestamp: '2026-08-13T09:00:00Z' },
      { role: 'agent', agent: 'dev', text: first + second + third, timestamp: '2026-08-13T09:00:30Z' },
    ]);

    const res = await getHistory({
      conversationId: convoId,
      sessionIds: [{ sessionId: 'sess-multi-1' }],
    });

    assert.strictEqual(res.messages.length, 2, 'one user turn and one agent turn');
    const agentMsg = res.messages[1];
    assert.strictEqual(agentMsg.role, 'assistant');
    for (const [label, block] of [['first', first], ['second', second], ['final', third]]) {
      assert.ok(agentMsg.content.includes(block), `the ${label} block is shown`);
    }
    // Order matters as much as presence: a summary shown before the work that
    // produced it would read as nonsense.
    assert.ok(agentMsg.content.indexOf(first) < agentMsg.content.indexOf(second));
    assert.ok(agentMsg.content.indexOf(second) < agentMsg.content.indexOf(third));
  });

  test('a following agent whose opening repeats an earlier phrase stays separate', async () => {
    // The sharp case for the absorption rule. Agents sharing a house style
    // reuse phrases, so a second agent's short reply can legitimately open
    // with words that already appear inside the first agent's turn. A rule
    // that asked only whether the text appears ANYWHERE in the turn would
    // absorb it and attribute one agent's words to another. Requiring each
    // stretch to appear AFTER the previous one is what prevents that.
    const convoId = 'sh-multiblock-3';
    const shared = 'Here is the summary worth keeping.';
    writeSession('sess-echo', [
      userLine('Both of you report back', '2026-08-13T11:00:00Z'),
      assistantLine(`${shared} That was the first agent talking.`, '2026-08-13T11:00:05Z'),
      assistantLine(shared, '2026-08-13T11:00:10Z'),
    ]);
    writeTranscript(convoId, [
      { role: 'user', text: 'Both of you report back', timestamp: '2026-08-13T11:00:00Z' },
      { role: 'agent', agent: 'cos', text: `${shared} That was the first agent talking.`, timestamp: '2026-08-13T11:00:05Z' },
      { role: 'agent', agent: 'penn', text: shared, timestamp: '2026-08-13T11:00:10Z' },
    ]);

    const res = await getHistory({
      conversationId: convoId,
      sessionIds: [{ sessionId: 'sess-echo' }],
    });

    assert.strictEqual(res.messages.length, 3, 'the echoed reply is its own turn');
    assert.deepStrictEqual(res.messages.map(m => m.agentId), [null, 'cos', 'penn']);
    assert.strictEqual(res.messages[1].content, `${shared} That was the first agent talking.`,
      "the first agent's bubble is exactly its own turn, with nothing absorbed");
    assert.strictEqual(res.messages[2].content, shared);
  });

  test('a following agent turn is not swallowed into the one before it', async () => {
    // The guard on the change above. Two agents replying in sequence with no
    // user message between them is ordinary, and absorbing every assistant
    // entry up to the next user message would merge them into one bubble and
    // misattribute the second agent's words to the first.
    const convoId = 'sh-multiblock-2';
    writeSession('sess-two-agents', [
      userLine('Who can help', '2026-08-13T10:00:00Z'),
      assistantLine('Routing you to the specialist now', '2026-08-13T10:00:05Z'),
      assistantLine('Specialist here, this is my own separate answer', '2026-08-13T10:00:10Z'),
    ]);
    writeTranscript(convoId, [
      { role: 'user', text: 'Who can help', timestamp: '2026-08-13T10:00:00Z' },
      { role: 'agent', agent: 'cos', text: 'Routing you to the specialist now', timestamp: '2026-08-13T10:00:05Z' },
      { role: 'agent', agent: 'penn', text: 'Specialist here, this is my own separate answer', timestamp: '2026-08-13T10:00:10Z' },
    ]);

    const res = await getHistory({
      conversationId: convoId,
      sessionIds: [{ sessionId: 'sess-two-agents' }],
    });

    assert.strictEqual(res.messages.length, 3, 'the two agent turns stay separate');
    assert.deepStrictEqual(res.messages.map(m => m.agentId), [null, 'cos', 'penn']);
    assert.ok(!res.messages[1].content.includes('Specialist here'),
      "the first agent's bubble did not absorb the second agent's reply");
  });

});

describe('get_session_history: single-session fallback', () => {
  test('without sessionIds, the named session is read directly with limit and offset', async () => {
    const convoId = 'sh-single-1';
    writeSession('sess-single-1', [
      userLine('First', null),
      assistantLine('Second', null),
      userLine('Third', null),
    ]);

    const res = await getHistory({ conversationId: convoId, sessionId: 'sess-single-1', limit: 2 });

    assert.deepStrictEqual(res.messages.map(m => [m.role, m.content]), [
      ['assistant', 'Second'],
      ['user', 'Third'],
    ]);
    assert.strictEqual(res.totalCount, 3);
    assert.strictEqual(res.hasMore, true);
  });

  test('an unknown session answers empty, so the client renders a blank history rather than hanging', async () => {
    const convoId = 'sh-single-missing-1';
    const res = await getHistory({ conversationId: convoId, sessionId: 'sess-never-existed' });
    assert.deepStrictEqual(res, {
      type: 'session_history', conversationId: convoId, messages: [], totalCount: 0, hasMore: false,
    });
  });
});
