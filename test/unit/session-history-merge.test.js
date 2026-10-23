'use strict';
// HISTORY THE SESSION FILE ALONE HOLDS, AND A NEW TURN AFTER IT.
//
// A conversation can reach Rundock with its history in Claude Code's session
// files and no Rundock transcript: imported, from before transcripts existed,
// or seeded. Its first new message starts a transcript, and the transcript is
// what orders and attributes history from then on. Before this was fixed, the
// whole of the earlier history vanished from view at that moment, though
// nothing on disk was touched.
//
// These drive the real history handler, with each new turn appended by the
// server's own appendTranscript, exactly as server.js appends it: the
// person's message before Claude Code is sent it, the agent's turn when it
// ends. A parser stands in for the session files, so a test names exactly the
// lines each file holds.
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const { _internal: srv } = require('../../server.js');
const { handleGetSessionHistory } = require('../../lib/protocol/handlers/history.js');
const { buildDelegateContext, buildScopeReturnPrompt } = require('../../lib/delegation/catch-up.js');
const { makeWorkspace, cleanup, standardTeam } = require('../helpers/workspace.js');

after(cleanup);
beforeEach(() => {
  srv.setWorkspace(makeWorkspace({ agents: standardTeam() }));
  srv.convoTranscripts.clear();
});

const user = (content, timestamp) => ({ role: 'user', content, timestamp });
const reply = (content, timestamp) => ({ role: 'assistant', content, timestamp });
// A moment just after now: what Claude Code stamps on the lines of a turn it
// is sent once Rundock has recorded the message.
const later = (ms) => new Date(Date.now() + ms).toISOString();

// The real handler, given each session file's parsed lines, in the order the
// conversation lists its sessions.
async function history(convoId, sessions, extra = {}) {
  const ctx = { store: { parseSessionHistory: async (sessionId) => ({ messages: sessions[sessionId] || [] }) } };
  const sent = [];
  handleGetSessionHistory(ctx, { send: (s) => sent.push(JSON.parse(s)) }, {
    conversationId: convoId,
    sessionIds: Object.keys(sessions).map((sessionId) => ({ sessionId })),
    ...extra,
  });
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sent.length, 1, 'the handler answered once');
  return sent[0];
}

// One new turn, appended as server.js appends it.
function newTurn(convoId, said, answered, agent = 'content-lead') {
  srv.appendTranscript(convoId, 'user', 'user', said);
  srv.appendTranscript(convoId, 'agent', agent, answered);
}

describe('a new turn after history only the session file holds', () => {
  test('the earlier history stays in view, in order, before the new turn, and pages with it', async () => {
    const convoId = 'imported-launch-plan';
    const earlier = [
      user('What should the launch plan cover?', '2026-01-05T09:00:00.000Z'),
      reply('Three things: audience, timing and channels.', '2026-01-05T09:00:20.000Z'),
      user('Draft the timing section.', '2026-01-05T09:05:00.000Z'),
      reply('Here is the timing section, in three phases.', '2026-01-05T09:05:40.000Z'),
    ];
    newTurn(convoId, 'Now the channels section.', 'Channels: email first, then the community forum.');
    const sessions = { 'sess-launch': [...earlier,
      user('Now the channels section.', later(50)),
      reply('Channels: email first, then the community forum.', later(80))] };

    const res = await history(convoId, sessions);
    assert.deepStrictEqual(res.messages.map((m) => m.content), [
      'What should the launch plan cover?',
      'Three things: audience, timing and channels.',
      'Draft the timing section.',
      'Here is the timing section, in three phases.',
      'Now the channels section.',
      'Channels: email first, then the community forum.',
    ]);
    assert.deepStrictEqual(res.messages.map((m) => m.agentId), [null, null, null, null, null, 'content-lead'],
      'the transcript still attributes the turn it records');
    assert.deepStrictEqual(res.messages.slice(0, 4).map((m) => m.timestamp), earlier.map((m) => m.timestamp));
    assert.strictEqual(res.totalCount, 6);
    assert.strictEqual(res.hasMore, false);

    // Load more pages back through the earlier history like any other.
    const last = await history(convoId, sessions, { limit: 4 });
    assert.deepStrictEqual(last.messages.map((m) => m.content), [
      'Draft the timing section.',
      'Here is the timing section, in three phases.',
      'Now the channels section.',
      'Channels: email first, then the community forum.',
    ]);
    assert.strictEqual(last.totalCount, 6);
    assert.strictEqual(last.hasMore, true);
    const first = await history(convoId, sessions, { limit: 4, offset: 4 });
    assert.deepStrictEqual(first.messages.map((m) => m.content), [
      'What should the launch plan cover?',
      'Three things: audience, timing and channels.',
    ]);
    assert.strictEqual(first.hasMore, false);
  });

  test('words said again in the new turn are matched to the new turn\'s own lines, never the earlier ones', async () => {
    // The transcript's turns are looked up in the session files by their
    // opening words. Earlier lines that open the same way must not be taken
    // for them: the earlier pair would then be shown at the end, and the new
    // turn's own lines would vanish.
    const convoId = 'imported-repeat';
    const earlier = [
      user('Yes please', '2026-01-06T10:00:00.000Z'),
      reply('Done, the outline is saved.', '2026-01-06T10:00:30.000Z'),
    ];
    newTurn(convoId, 'Yes please', 'Done, the outline is saved.');
    const now = [user('Yes please', later(50)), reply('Done, the outline is saved.', later(80))];

    const res = await history(convoId, { 'sess-repeat': [...earlier, ...now] });
    assert.deepStrictEqual(res.messages.map((m) => [m.content, m.timestamp]),
      [...earlier, ...now].map((m) => [m.content, m.timestamp]));
    assert.deepStrictEqual(res.messages.map((m) => m.agentId), [null, null, null, 'content-lead']);
  });

  test('a new turn written in several stretches after earlier history is one whole bubble', async () => {
    // The session file splits an agent turn at each tool call, and the turn is
    // rebuilt by walking forward from the stretch that matched it. That walk
    // must go through the lines the transcript's turns are matched among, not
    // through a list that still holds the earlier history in front of them.
    const convoId = 'imported-stretches';
    const first = 'Checking what the brief already covers before writing anything.';
    const second = 'The brief covers audience and tone; the draft follows.';
    newTurn(convoId, 'Write the opening paragraph.', first + second);
    const res = await history(convoId, { 'sess-stretches': [
      user('What tone should the brief take?', '2026-01-06T15:00:00.000Z'),
      reply('Plain and direct, with no jargon.', '2026-01-06T15:00:20.000Z'),
      user('Write the opening paragraph.', later(50)),
      reply(first, later(70)),
      reply(second, later(90)),
    ] });
    assert.deepStrictEqual(res.messages.map((m) => m.content), [
      'What tone should the brief take?',
      'Plain and direct, with no jargon.',
      'Write the opening paragraph.',
      `${first}\n\n${second}`,
    ]);
  });

  test('a conversation over several session files keeps its earlier history in time order', async () => {
    // Read file by file, a specialist's reply would land after everything the
    // orchestrator said, which is the ordering fault the transcript was made
    // the authority to end. Before the transcript, time is what orders them.
    const convoId = 'imported-offsite';
    newTurn(convoId, 'Book the lakeside venue.', 'Booked, and the agenda is attached.', 'chief-of-staff');
    const res = await history(convoId, {
      'sess-orchestrator': [
        user('Plan the team offsite.', '2026-01-07T09:00:00.000Z'),
        reply('Handing the venue question to the specialist.', '2026-01-07T09:00:10.000Z'),
        user('And the agenda?', '2026-01-07T09:20:00.000Z'),
        reply('Agenda drafted: two sessions a day.', '2026-01-07T09:20:30.000Z'),
        user('Book the lakeside venue.', later(50)),
        reply('Booked, and the agenda is attached.', later(80)),
      ],
      'sess-venue': [
        reply('Three venues fit the budget; the lakeside one is closest.', '2026-01-07T09:05:00.000Z'),
      ],
    });
    assert.deepStrictEqual(res.messages.map((m) => m.content), [
      'Plan the team offsite.',
      'Handing the venue question to the specialist.',
      'Three venues fit the budget; the lakeside one is closest.',
      'And the agenda?',
      'Agenda drafted: two sessions a day.',
      'Book the lakeside venue.',
      'Booked, and the agenda is attached.',
    ]);
  });

  test('a resumed session whose new file repeats the earlier lines shows them once', async () => {
    const convoId = 'imported-resumed';
    const earlier = [
      user('Summarise the quarterly numbers.', '2026-01-08T11:00:00.000Z'),
      reply('Revenue rose eight percent; costs held flat.', '2026-01-08T11:00:40.000Z'),
    ];
    newTurn(convoId, 'And the forecast?', 'The forecast holds at six percent.');
    const res = await history(convoId, {
      'sess-quarterly': earlier,
      // The resumed file carries the same lines again before the new turn.
      'sess-quarterly-resumed': [...earlier,
        user('And the forecast?', later(50)),
        reply('The forecast holds at six percent.', later(80))],
    });
    assert.deepStrictEqual(res.messages.map((m) => m.content), [
      'Summarise the quarterly numbers.',
      'Revenue rose eight percent; costs held flat.',
      'And the forecast?',
      'The forecast holds at six percent.',
    ]);
  });

  test('the person\'s own message, stamped in the same millisecond as its transcript entry, is shown once', async () => {
    // Rundock records the message before Claude Code is sent it, so the
    // session's copy is never earlier: at most the same moment. That copy
    // belongs to the transcript's turn, not to the history before it.
    const convoId = 'imported-same-moment';
    newTurn(convoId, 'Send the summary to the team.', 'Sent to the team list.');
    const at = srv.loadTranscript(convoId)[0].timestamp;
    const res = await history(convoId, { 'sess-same': [
      user('Who is on the team list?', '2026-01-09T08:00:00.000Z'),
      reply('Five people, all in the design group.', '2026-01-09T08:00:15.000Z'),
      user('Send the summary to the team.', at),
      reply('Sent to the team list.', later(80)),
    ] });
    assert.deepStrictEqual(res.messages.map((m) => m.content), [
      'Who is on the team list?',
      'Five people, all in the design group.',
      'Send the summary to the team.',
      'Sent to the team list.',
    ]);
  });

  test('what the session holds from after the transcript began, and the transcript does not name, stays hidden', async () => {
    // The transcript decides what is shown once it exists. A delegate's file
    // opens with the brief Rundock sent it, behind the catch-up it missed, and
    // an orchestrator that hands over answers <silent>: neither is a message
    // anyone wrote to the conversation, and neither may appear.
    const convoId = 'imported-delegated';
    srv.appendTranscript(convoId, 'user', 'user', 'Find us three venues.');
    srv.appendTranscript(convoId, 'agent', 'chief-of-staff', '', 'routing');
    srv.appendTranscript(convoId, 'agent', 'research-lead', 'Three venues found, all within budget.');
    const res = await history(convoId, {
      'sess-orch-delegated': [
        user('Is the budget agreed?', '2026-01-10T09:00:00.000Z'),
        reply('Yes, agreed at the last review.', '2026-01-10T09:00:20.000Z'),
        user('Find us three venues.', later(50)),
        reply('<silent>', later(140)),
      ],
      'sess-research-delegated': [
        user('SINCE YOUR LAST TURN IN THIS CONVERSATION:\nUSER: Find us three venues.\n\n[DELEGATION BRIEF]\nFind three venues within budget.', later(70)),
        reply('Three venues found, all within budget.', later(110)),
      ],
    });
    assert.deepStrictEqual(res.messages.filter((m) => m.type !== 'routing').map((m) => m.content), [
      'Is the budget agreed?',
      'Yes, agreed at the last review.',
      'Find us three venues.',
      'Three venues found, all within budget.',
    ]);
    assert.ok(res.messages.some((m) => m.type === 'routing' && m.agentId === 'chief-of-staff'), 'the handover divider is kept');
  });

  test('a delegation from before the transcript began shows what was said, never Rundock\'s own prompts', async () => {
    // Rundock's prompts open with a catch-up heading as often as not, and an
    // orchestrator answers a finished delegation with <silent>. Neither is a
    // message, from before the transcript or after it. Built by Rundock's own
    // builders, so the test reads the prompts exactly as agents receive them.
    const brief = buildDelegateContext({ missed: { text: 'USER: Plan the offsite.' }, brief: 'Find three venues within budget.', arriving: true });
    const handback = buildScopeReturnPrompt({ mode: 'complete', orchMissed: { text: 'RESEARCH-LEAD: Three venues fit.' }, specialistId: 'research-lead', outputBlock: '\n\nThree venues fit the budget.' });
    const resumed = buildScopeReturnPrompt({ mode: 'continue', orchMissed: { text: 'USER: Which is closest?' }, specialistId: 'research-lead', outputBlock: '\n\nThe lakeside one.' });
    assert.ok(brief.startsWith('THE CONVERSATION SO FAR, BEFORE YOU JOINED:') && handback.startsWith('SINCE YOUR LAST TURN IN THIS CONVERSATION:'),
      'precondition: both catch-up headings are in play');
    const sessions = {
      'sess-orch-before': [
        user('Plan the offsite.', '2026-01-12T09:00:00.000Z'),
        reply('Handing the venues to the research lead.', '2026-01-12T09:00:10.000Z'),
        user(handback, '2026-01-12T09:03:00.000Z'),
        reply('<silent>', '2026-01-12T09:03:05.000Z'),
        user(resumed, '2026-01-12T09:04:00.000Z'),
        reply('<silent> <!-- RUNDOCK:COMPLETE -->', '2026-01-12T09:04:05.000Z'),
        user('Which is closest?', '2026-01-12T09:10:00.000Z'),
        reply('The lakeside one, twenty minutes away.', '2026-01-12T09:10:20.000Z'),
      ],
      'sess-research-before': [
        user(brief, '2026-01-12T09:01:00.000Z'),
        reply('Three venues fit the budget.', '2026-01-12T09:02:00.000Z'),
      ],
    };
    const said = [
      'Plan the offsite.',
      'Handing the venues to the research lead.',
      'Three venues fit the budget.',
      'Which is closest?',
      'The lakeside one, twenty minutes away.',
    ];

    // With no transcript at all, the session files are the history.
    const alone = await history('delegated-no-transcript', sessions);
    assert.deepStrictEqual([...alone.messages.map((m) => m.content)].sort(), [...said].sort());

    // And with one, they are the history before it.
    const convoId = 'delegated-before-start';
    newTurn(convoId, 'Book the lakeside venue.', 'Booked for the first week of March.', 'chief-of-staff');
    const res = await history(convoId, { ...sessions, 'sess-orch-before': [...sessions['sess-orch-before'],
      user('Book the lakeside venue.', later(50)),
      reply('Booked for the first week of March.', later(80))] });
    assert.deepStrictEqual(res.messages.map((m) => m.content), [...said, 'Book the lakeside venue.', 'Booked for the first week of March.']);
  });

  test('a transcript that opens with an agent turn shows what it always showed', async () => {
    // Only a transcript that opens with the person's own message says when it
    // began. One that opens with an agent turn was started by a prompt Rundock
    // sent, which is not a message to show, so nothing is claimed as earlier.
    const convoId = 'agent-opened';
    srv.appendTranscript(convoId, 'agent', 'research-lead', 'Welcome. Here is what is in this workspace.');
    const res = await history(convoId, { 'sess-agent-opened': [
      user('Open with a short tour of the workspace for a first visit.', '2026-01-11T07:59:00.000Z'),
      reply('Welcome. Here is what is in this workspace.', '2026-01-11T07:59:30.000Z'),
    ] });
    assert.deepStrictEqual(res.messages.map((m) => m.content), ['Welcome. Here is what is in this workspace.']);
  });
});

describe('which session lines are Rundock\'s own', () => {
  const lines = require('../../lib/delegation/rundock-lines.js');
  test('every prompt Rundock\'s builders write is one, whichever heading it opens with', () => {
    const missed = { text: 'USER: Plan the offsite.' };
    const prompts = [
      buildDelegateContext({ missed, brief: 'Find three venues.', arriving: true }),
      buildDelegateContext({ missed, brief: 'Find three venues.', arriving: false }),
      buildDelegateContext({ missed: { text: null }, brief: 'Find three venues.' }),
      ...['complete', 'continue', 'return'].flatMap((mode) => [missed, { text: null }].map((orchMissed) => buildScopeReturnPrompt({
        mode, orchMissed, specialistId: 'research-lead', outputBlock: '\n\nThree venues.', pendingRequest: 'Book one.',
      }))),
      'CONVERSATION SO FAR:\nUSER: hello',
      '[SYSTEM: A specialist just returned. Ask the user what they need next.]',
    ];
    for (const p of prompts) assert.strictEqual(lines.isRundockPrompt(p), true, p.slice(0, 60));
    for (const said of ['Plan the offsite.', 'Since your last turn, the plan changed.', 'What is a [DELEGATION BRIEF]?']) {
      assert.strictEqual(lines.isRundockPrompt(said), false, said);
    }
  });
  test('a reply that is only the <silent> sentinel is one; a short reply of the agent\'s own is not', () => {
    for (const r of ['<silent>', '<SILENT>', '  <silent>\n', '<silent> <!-- RUNDOCK:COMPLETE -->', 'No response requested.']) {
      assert.strictEqual(lines.isRundockReply(r), true, r);
    }
    for (const r of ['Done.', 'OK', 'Yes, agreed.', 'Say <silent> to park me.', '<!-- RUNDOCK:COMPLETE -->']) {
      assert.strictEqual(lines.isRundockReply(r), false, r);
    }
    // The same sentinel test the live path parks a reply by.
    for (const r of ['<silent>', '<SILENT>', '<silent> <!-- RUNDOCK:COMPLETE -->']) assert.strictEqual(srv.isSilentParkResponse(r), true, r);
  });
});
