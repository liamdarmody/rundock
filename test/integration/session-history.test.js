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

function toolResultLine(text, timestamp) {
  // Shaped as Claude Code writes it: user role, ARRAY content. The parser
  // admits user entries only when their content is a string, so these never
  // reach the merge pool. The regression test below includes them anyway, so
  // that if that filter is ever relaxed the absorption walk does not silently
  // start stopping at the first tool result and lose the rest of the turn.
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text }] }, timestamp: timestamp || null };
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
      { role: 'agent', agent: 'wren', text: 'Here is the draft you asked for, complete with the long', timestamp: '2026-08-11T10:01:00Z' },
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
      ['assistant', 'wren'],
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
      { role: 'agent', agent: 'wren', text: 'Specialist reporting in' },
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
      toolResultLine('file contents here', '2026-08-13T09:00:12Z'),
      assistantLine(second, '2026-08-13T09:00:20Z'),
      toolLine('Edit', '2026-08-13T09:00:21Z'),
      toolResultLine('edit applied', '2026-08-13T09:00:22Z'),
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
      { role: 'agent', agent: 'wren', text: shared, timestamp: '2026-08-13T11:00:10Z' },
    ]);

    const res = await getHistory({
      conversationId: convoId,
      sessionIds: [{ sessionId: 'sess-echo' }],
    });

    assert.strictEqual(res.messages.length, 3, 'the echoed reply is its own turn');
    assert.deepStrictEqual(res.messages.map(m => m.agentId), [null, 'cos', 'wren']);
    assert.strictEqual(res.messages[1].content, `${shared} That was the first agent talking.`,
      "the first agent's bubble is exactly its own turn, with nothing absorbed");
    assert.strictEqual(res.messages[2].content, shared);
  });

  test('an echo occurring late in the first turn still leaves the reply separate', async () => {
    // Sharper than the case above, and the one that decides how far the walk
    // advances after a match. Here the repeated phrase sits well past the
    // sixty characters used to recognise a stretch, so a walk that stepped
    // forward only by that head would still be inside the first agent's text
    // and would match the echo there, absorbing a reply that belongs to
    // someone else. Stepping past the whole stretch is what rules it out.
    const convoId = 'sh-multiblock-4';
    const echoed = 'and that is the recommendation I would make here.';
    const firstTurn = 'Opening remarks that comfortably exceed the sixty characters used to '
      + `recognise a stretch, followed by the phrase in question, ${echoed} Then a further `
      + 'sentence so the echo is not at the end either.';
    writeSession('sess-late-echo', [
      userLine('Both of you weigh in', '2026-08-13T12:00:00Z'),
      assistantLine(firstTurn, '2026-08-13T12:00:05Z'),
      assistantLine(echoed, '2026-08-13T12:00:10Z'),
    ]);
    writeTranscript(convoId, [
      { role: 'user', text: 'Both of you weigh in', timestamp: '2026-08-13T12:00:00Z' },
      { role: 'agent', agent: 'cos', text: firstTurn, timestamp: '2026-08-13T12:00:05Z' },
      { role: 'agent', agent: 'wren', text: echoed, timestamp: '2026-08-13T12:00:10Z' },
    ]);

    const res = await getHistory({
      conversationId: convoId,
      sessionIds: [{ sessionId: 'sess-late-echo' }],
    });

    assert.strictEqual(res.messages.length, 3);
    assert.deepStrictEqual(res.messages.map(m => m.agentId), [null, 'cos', 'wren']);
    assert.strictEqual(res.messages[1].content, firstTurn, 'nothing absorbed into the first turn');
    assert.strictEqual(res.messages[2].content, echoed);
    // Present once as its own turn, not duplicated into the bubble before it.
    const occurrences = res.messages.filter(m => m.content === echoed).length;
    assert.strictEqual(occurrences, 1, 'the reply appears exactly once');
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
      { role: 'agent', agent: 'wren', text: 'Specialist here, this is my own separate answer', timestamp: '2026-08-13T10:00:10Z' },
    ]);

    const res = await getHistory({
      conversationId: convoId,
      sessionIds: [{ sessionId: 'sess-two-agents' }],
    });

    assert.strictEqual(res.messages.length, 3, 'the two agent turns stay separate');
    assert.deepStrictEqual(res.messages.map(m => m.agentId), [null, 'cos', 'wren']);
    assert.ok(!res.messages[1].content.includes('Specialist here'),
      "the first agent's bubble did not absorb the second agent's reply");
  });

});

describe('get_session_history: a new turn after history only the session file holds', () => {
  test('the earlier history stays in view after a real turn, and search still finds it', async () => {
    // Imported, seeded, or older than transcripts: the conversation's history
    // is in its session file and there is no transcript. A real chat turn then
    // goes through the server, which starts the transcript with it. Before the
    // fix, history read back showed that turn alone.
    const convoId = 'sh-earlier-1';
    const sessionId = 'sess-earlier-1';
    writeSession(sessionId, [
      userLine('Who is the launch plan for?', '2026-01-05T09:00:00.000Z'),
      assistantLine('The audience is small teams moving off spreadsheets.', '2026-01-05T09:00:20.000Z'),
      userLine('Draft the timing section.', '2026-01-05T09:05:00.000Z'),
      assistantLine('Here is the timing section, in three phases.', '2026-01-05T09:05:40.000Z'),
    ]);
    const sessionIds = [{ sessionId, agentId: 'lead-designer' }];
    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'lead-designer', title: 'Imported plan', sessionId, sessionIds } });
    // A resumed spawn names no agent, so the rule matches on the prompt.
    h.writeScenario([{ match: { promptIncludes: 'channels section' }, turn: [{ text: 'Channels: email first, then the forum.' }] }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'Now the channels section.', sessionId });
    await client.waitForEvent('system', 'done', convoId);
    const transcript = JSON.parse(fs.readFileSync(path.join(h.workspaceDir, '.rundock', 'transcripts', `${convoId}.json`), 'utf-8'));
    assert.deepStrictEqual(transcript.map((t) => [t.role, t.agent]), [['user', 'user'], ['agent', 'lead-designer']],
      'the turn started a transcript, as it does for any conversation');
    // The resumed session file gains the turn's lines, as Claude Code writes
    // them; the stub claude keeps no session file when resuming.
    fs.appendFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), [
      userLine('Now the channels section.', new Date().toISOString()),
      assistantLine('Channels: email first, then the forum.', new Date(Date.now() + 5).toISOString()),
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');

    const res = await getHistory({ conversationId: convoId, sessionIds });
    assert.deepStrictEqual(res.messages.map((m) => m.content), [
      'Who is the launch plan for?',
      'The audience is small teams moving off spreadsheets.',
      'Draft the timing section.',
      'Here is the timing section, in three phases.',
      'Now the channels section.',
      'Channels: email first, then the forum.',
    ]);
    assert.strictEqual(res.messages.at(-1).agentId, 'lead-designer');
    assert.strictEqual(res.totalCount, 6);

    // Search reads the session files, never the transcript, and a turn only
    // adds to what it has read: the earlier message is still found.
    const since = client.messages.length;
    client.send({ type: 'search_conversations', query: 'spreadsheets' });
    const { msg: found } = await client.waitFor((m) => m.type === 'search_results' && m.query === 'spreadsheets', { since, label: 'search_results' });
    const hit = found.results.find((r) => r.id === convoId);
    assert.ok(hit, `the conversation is found by its earlier words: ${JSON.stringify(found.results.map((r) => r.id))}`);
    assert.strictEqual(hit.matchType, 'content');
  });
});

describe('Rundock\'s own lines in a session file, in history and in the message count', () => {
  test('a delegation\'s prompts and the <silent> sentinel are neither shown nor counted', async () => {
    // Real parser, real counts: the conversation list and the history read the
    // same files and must agree on what a message is.
    const { buildDelegateContext, buildScopeReturnPrompt } = require('../../lib/delegation/catch-up.js');
    const brief = buildDelegateContext({ missed: { text: 'USER: Plan the offsite.' }, brief: 'Find three venues.', arriving: true });
    const handback = buildScopeReturnPrompt({ mode: 'complete', orchMissed: { text: 'RESEARCH-LEAD: Three venues.' }, specialistId: 'research-lead', outputBlock: '\n\nThree venues.' });
    writeSession('sess-own-orch', [
      userLine('Plan the offsite.', '2026-01-12T09:00:00.000Z'),
      assistantLine('Handing the venues to the research lead.', '2026-01-12T09:00:10.000Z'),
      userLine(handback, '2026-01-12T09:03:00.000Z'),
      assistantLine('<silent>', '2026-01-12T09:03:05.000Z'),
    ]);
    writeSession('sess-own-research', [
      userLine(brief, '2026-01-12T09:01:00.000Z'),
      assistantLine('Three venues fit the budget.', '2026-01-12T09:02:00.000Z'),
    ]);
    const convoId = 'sh-own-lines';
    const sessionIds = [{ sessionId: 'sess-own-orch', agentId: 'chief-of-staff' }, { sessionId: 'sess-own-research', agentId: 'research-lead' }];
    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Offsite', sessionIds } });

    const res = await getHistory({ conversationId: convoId, sessionIds });
    assert.deepStrictEqual(res.messages.map((m) => m.content), [
      'Plan the offsite.',
      'Handing the venues to the research lead.',
      'Three venues fit the budget.',
    ]);

    const since = client.messages.length;
    client.send({ type: 'get_conversations' });
    const { msg } = await client.waitFor((m) => m.type === 'conversations', { since, label: 'conversations' });
    const listed = msg.conversations.find((c) => c.id === convoId);
    assert.ok(listed, 'the conversation is listed');
    assert.strictEqual(listed.messageCount, 3, 'the count is what the history shows');
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
