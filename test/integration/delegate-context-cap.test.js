'use strict';
// WHAT A DELEGATION HANDS OVER WHEN NOBODY CALLED THE AGENT TOOL.
//
// A delegation starts one of two ways. An agent calls the Agent tool and the
// engine intercepts it, or an agent writes the handoff marker into its own
// reply, the client scans it out and asks for the delegation over the socket.
// The first was measured and capped. The second was not: it rendered the whole
// conversation, every turn and every tool summary, with no character bound on
// it at all, and handed that to the arriving agent. On the longest real
// three-agent conversation on disk that is 47 million tokens against 89
// thousand for the capped delta, and nothing on screen said which of the two a
// delegation had taken.
//
// DRIVEN, NOT READ. The unit suite proves the assembly is bounded and that the
// engine cannot reach the transcript except through the cap. Neither proves
// what leaves the server: a value computed correctly and then not threaded, or
// threaded and then rebuilt somewhere downstream, passes all of them. These
// send the same message the client sends and read back the literal bytes the
// delegate process was given on stdin.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const h = require('../helpers/harness.js');

const ROOT = path.join(__dirname, '..', '..');
const { DELTA_CAP_CHARS } = require(path.join(ROOT, 'lib', 'store', 'transcripts.js'));

let client;
before(async () => { await h.boot(); client = await h.connect(); });
after(h.shutdown);

/** A conversation far larger than any cap, in the shape that made it costly. */
function hugeTranscript() {
  const entries = [
    { role: 'user', text: 'OLDEST-USER-TURN: write me something' },
    { role: 'agent', agent: 'chief-of-staff', text: 'OLDEST-AGENT-TURN ' + 'a'.repeat(20000) },
  ];
  for (let i = 0; i < 30; i++) {
    entries.push({
      role: 'agent',
      agent: i % 2 ? 'content-analyst' : 'lead-designer',
      text: `[Read] notes-${i}.md (${i} lines)\n` + 'b'.repeat(20000),
    });
  }
  entries.push({ role: 'agent', agent: 'chief-of-staff', text: 'NEWEST-TURN: and here is where we got to' });
  return entries;
}

// A COPY, ALWAYS. The live transcript map is the one the server appends to,
// so seeding two conversations from one array would let the first delegate's
// own reply land in the second conversation's history.
function seed(convoId, entries) {
  h.internal.convoTranscripts.set(convoId, entries.map(e => ({ ...e })));
  h.internal.saveTranscript(convoId);
}

/** A live parent for the socket route to delegate away from. */
function parkParent(convoId, processId) {
  h.internal.chatProcesses.set(convoId, {
    agentId: 'chief-of-staff', processId, exited: false, toolCalls: [],
  });
}

// Every prompt this file has watched an agent receive, kept here because the
// per-test prompt log is cleared between tests and the last check in the file
// asks its question of the whole run.
const everyPromptSeen = [];

async function waitForPrompt(agentId, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const prompts = h.promptsFor(agentId);
    if (prompts.length) {
      const prompt = prompts[prompts.length - 1];
      everyPromptSeen.push({ agent: agentId, prompt });
      return prompt;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`no prompt reached ${agentId} within ${timeoutMs}ms`);
}

// The cap bounds the conversation the delegate is given. The brief and the
// heading above it sit outside that, so the bound a prompt is judged against is
// the cap plus those, not the cap alone.
function ceilingFor(brief) { return DELTA_CAP_CHARS + brief.length + 200; }

describe('a delegation asked for over the socket hands over a capped context', () => {
  test('the delegate receives the cap, not the conversation', async () => {
    const convoId = h.freshConvoId('cap-socket');
    seed(convoId, hugeTranscript());
    h.internal.writeConversations([{ id: convoId, title: 'socket', messages: [], sessionIds: [] }]);
    parkParent(convoId, 'p-socket');
    h.clearPrompts();

    // THE MESSAGE THE CLIENT SENDS. public/markers.js scans an agent's reply
    // for the handoff marker and public/app.js posts exactly this; the scan is
    // client-side, so sending the message is how the route is reached from a
    // server-side test.
    const brief = 'pick this up please';
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: brief });

    const prompt = await waitForPrompt('content-lead');
    assert.ok(prompt.length <= ceilingFor(brief),
      `the delegate was handed ${prompt.length} characters against a ceiling of ${ceilingFor(brief)}. `
      + 'This route used to render the whole conversation with no character bound, which is the '
      + 'defect: the same delegation through the Agent tool was capped at ' + DELTA_CAP_CHARS);
    assert.match(prompt, /NEWEST-TURN/,
      'and it is the recent end of the conversation that survived, which is what an arriving '
      + 'agent most needs');
    assert.ok(!prompt.includes('OLDEST-AGENT-TURN'),
      'while the far end was dropped rather than sent, or nothing was actually capped');
    assert.match(prompt, /pick this up please/, 'and the brief still arrives');
    h.reapConvo(convoId);
  });

  test('and is told what was left out rather than quietly given less', async () => {
    const convoId = h.freshConvoId('cap-socket-note');
    seed(convoId, hugeTranscript());
    h.internal.writeConversations([{ id: convoId, title: 'note', messages: [], sessionIds: [] }]);
    parkParent(convoId, 'p-socket-note');
    h.clearPrompts();

    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'go' });

    const prompt = await waitForPrompt('content-lead');
    assert.match(prompt, /BEFORE YOU JOINED/,
      'an agent that has never spoken here is arriving, and saying "since your last turn" to it '
      + 'makes it reason from a false premise about its own history');
    assert.match(prompt, /earlier turn|omitted|truncat/i,
      'a shortened conversation that does not say it was shortened reads as the whole of it');
    h.reapConvo(convoId);
  });
});

describe('both ways of starting a delegation hand over the same thing', () => {
  // CD of the whole card, stated as a property rather than as two separate
  // budgets that happen to be close. The two routes differ only in who asked
  // for the delegation, and an arriving agent's need does not depend on that.
  test('the same conversation produces the same context on either route', async () => {
    const entries = hugeTranscript();
    const brief = 'identical brief on both routes';

    const socketConvo = h.freshConvoId('cap-parity-socket');
    seed(socketConvo, entries);
    h.internal.writeConversations([{ id: socketConvo, title: 'parity-a', messages: [], sessionIds: [] }]);
    parkParent(socketConvo, 'p-parity-a');
    h.clearPrompts();
    client.send({ type: 'delegate', conversationId: socketConvo, targetAgent: 'content-lead', context: brief });
    const viaSocket = await waitForPrompt('content-lead');
    h.reapConvo(socketConvo);

    const agentToolConvo = h.freshConvoId('cap-parity-agent');
    seed(agentToolConvo, entries);
    h.internal.writeConversations([{ id: agentToolConvo, title: 'parity-b', messages: [], sessionIds: [] }]);
    parkParent(agentToolConvo, 'p-parity-b');
    h.clearPrompts();
    h.internal.handleDelegation({
      conversationId: agentToolConvo, targetAgent: 'content-lead', context: brief,
      _intercepted: true, _parentAgentId: 'chief-of-staff',
    }, h.internal.chatProcesses);
    const viaAgentTool = await waitForPrompt('content-lead');
    h.reapConvo(agentToolConvo);

    assert.strictEqual(viaSocket, viaAgentTool,
      'the two routes handed the arriving agent different text for the same conversation. '
      + 'Same admission rules, same stripping, same pinned user turns, same declaration of '
      + 'what was omitted, or the route it came in by is a fact about its context');
  });
});

describe('an agent that has been here before still resumes', () => {
  // The cap must not turn a resume into an arrival. A returning delegate has
  // its own thread and needs only the turns it missed; handing it the whole
  // conversation again is both the cost this card exists to remove and an
  // invitation to redo work it has already done.
  test('on the socket route it is given what it missed, not the conversation', async () => {
    const convoId = h.freshConvoId('cap-resume');
    seed(convoId, [
      { role: 'user', text: 'write me a short blog post' },
      { role: 'agent', agent: 'chief-of-staff', text: 'Handing this to Penn.' },
      { role: 'agent', agent: 'content-lead', text: 'PENN-OWN-FIRST-DRAFT: here is the draft' },
      { role: 'agent', agent: 'content-analyst', text: 'ANALYST-INTERVENING: the numbers check out' },
    ]);
    h.internal.writeConversations([{
      id: convoId, title: 'resume', messages: [],
      sessionIds: [{ agentId: 'content-lead', sessionId: 'sess-penn-cap' }],
    }]);
    parkParent(convoId, 'p-resume');
    h.clearInvocations();

    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'now tighten it' });

    const prompt = await waitForPrompt('content-lead');
    assert.match(prompt, /SINCE YOUR LAST TURN/,
      'a returning agent is told what it missed, not walked through the room again');
    assert.match(prompt, /ANALYST-INTERVENING/, 'and that is what happened while it was away');
    assert.ok(!prompt.includes('PENN-OWN-FIRST-DRAFT'),
      'its own earlier turn is already in its thread; re-sending it is pure cost and invites '
      + 'it to redo work it has already done');

    const spawned = h.readInvocations().filter(i => i.agent === 'content-lead');
    assert.ok(spawned.length >= 1, 'the delegate was spawned');
    assert.strictEqual(spawned[spawned.length - 1].resume, 'sess-penn-cap',
      'and the thread was actually resumed, so this is a resume rather than an arrival '
      + 'wearing a resume heading');
    h.reapConvo(convoId);
  });
});

describe('nothing else in these runs left the server uncapped', () => {
  // The tests above name the routes that exist today. This one asks the
  // question without naming any: of everything the server sent a runtime while
  // those ran, was any of it larger than the cap allows. A third route added
  // later that skips the cap fails here as soon as anything exercises it, with
  // no list of routes to keep up to date.
  test('no prompt any agent received exceeded the cap', () => {
    const prompts = everyPromptSeen;
    assert.ok(prompts.length >= 5,
      `sanity: only ${prompts.length} prompts recorded, so this proves nothing yet`);
    const overCap = prompts
      .filter(p => p.prompt.length > DELTA_CAP_CHARS + 2000)
      .map(p => ({ agent: p.agent, chars: p.prompt.length }));
    assert.deepStrictEqual(overCap, [],
      'an agent was sent more than the cap allows. The conversations these tests seed are '
      + 'hundreds of times the cap, so anything that reaches a runtime unbounded shows up here '
      + 'whatever route carried it');
  });
});
