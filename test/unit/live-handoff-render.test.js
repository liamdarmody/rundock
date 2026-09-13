'use strict';
// A HANDOFF THE PERSON CAN SEE WHILE IT HAPPENS, asserted on the DOM.
//
// The defect these pin was invisible to every test in the release that shipped
// it, because every one of those tests asserted on the stored transcript. The
// transcript was correct. `appendTranscript` writes to memory and disk and
// tells no connected client, and the live path could only show a delegating
// agent's words by promoting a streaming bubble that an agent emitting a bare
// tool_use block never creates. So the line was right on reload and absent at
// the moment it happened, which is the only moment the person was watching.
//
// So these drive the real reducer and the real effect executor against a real
// document and assert on the nodes that end up in it. A transcript assertion
// discharges none of them, by construction: there is no transcript here.
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf-8');

// The executor lifted out of app.js and run, rather than reimplemented here.
// Reimplementing it would have passed before the fix: the bug was that the real
// one did nothing to the DOM when there was no bubble to promote.
function extractExecutor(name) {
  const key = `'${name}': (convoId, ef) => {`;
  const at = APP_SRC.indexOf(key);
  assert.ok(at > -1, `app.js still defines the ${name} executor; if this fails the wiring moved`);
  let i = at + key.length - 1, depth = 0;
  for (; i < APP_SRC.length; i++) {
    if (APP_SRC[i] === '{') depth++;
    else if (APP_SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = APP_SRC.slice(at + key.length, i);
  // eslint-disable-next-line no-new-func
  return new Function('convoId', 'ef', body);
}

let dom, chat, reduce, createState, promote, divider;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="messages"></div></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.Element.prototype.scrollIntoView = function () {};
  global.esc = (t) => String(t);
  global.formatMd = (t) => String(t);
  global.userScrolledUp = false;
  // The roster addAgentMsg resolves the speaker against, as index.html supplies it.
  global.agents = [{ id: 'default', displayName: 'Roo', type: 'orchestrator' }, { id: 'vox', displayName: 'Vox', type: 'specialist' }];
  global.RundockChatMarkup = require(path.join(ROOT, 'public', 'chat-markup.js'));
  chat = require(path.join(ROOT, 'public', 'views', 'chat.js'));
  Object.assign(global, chat);
  const cs = require(path.join(ROOT, 'public', 'conversation-state.js'));
  reduce = cs.reduce; createState = cs.createState;
  global.RundockMarkers = require(path.join(ROOT, 'public', 'markers.js'));
  promote = extractExecutor('promote-handoff-message');
  divider = extractExecutor('show-delegation-divider');
});

function freshDom() {
  document.getElementById('messages').innerHTML = '';
}
function renderedAgentTurns() {
  return [...document.getElementById('messages').children]
    .filter((el) => el.className.includes('msg-agent'))
    .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
}

describe('the handoff line is on screen while the handoff happens', () => {
  test('an agent that delegates without speaking still gets a visible turn', () => {
    // THE REPORTED DEFECT. Before the fix this rendered nothing at all: the
    // executor updated the in-memory conversation and returned, so the person
    // watched the conversation jump to a new agent with no explanation.
    freshDom();
    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1' };
    global.getConvoState = () => ({ currentStreamingMsg: null });

    promote('c1', { text: 'Handing to Vox to write the X.com thread.', agentId: 'default' });

    const turns = renderedAgentTurns();
    assert.strictEqual(turns.length, 1,
      'the delegating agent produced exactly one visible turn on screen');
    assert.match(turns[0], /Handing to Vox to write the X\.com thread\./,
      'carrying the line it wrote, in the document the person is looking at');
  });

  test('an agent that did speak has its own bubble promoted, never a second one', () => {
    // The other direction, so the fix cannot be satisfied by always appending:
    // a turn that streamed is already on screen and must not be duplicated.
    freshDom();
    const messages = document.getElementById('messages');
    const bubble = document.createElement('div');
    bubble.className = 'msg msg-agent';
    bubble.innerHTML = '<div class="streaming-text">partial</div>';
    messages.appendChild(bubble);

    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1' };
    global.getConvoState = () => ({ currentStreamingMsg: bubble });

    promote('c1', { text: 'I will take this to Vox.', agentId: 'default' });

    const turns = renderedAgentTurns();
    assert.strictEqual(turns.length, 1, 'one turn, not the streamed one plus an appended copy');
    assert.match(turns[0], /I will take this to Vox\./);
    assert.strictEqual(bubble.querySelector('.streaming-text'), null,
      'and the bubble stopped being a streaming one rather than being left mid-flight');
  });

  test('a conversation the person is not looking at renders nothing into this one', () => {
    freshDom();
    global.conversations = [{ id: 'c2', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1' };
    global.getConvoState = () => ({ currentStreamingMsg: null });

    promote('c2', { text: 'Handing to Ren.', agentId: 'default' });

    assert.deepStrictEqual(renderedAgentTurns(), [],
      'a handoff in a background conversation must not appear in the open one');
  });
});

describe('the whole pipeline puts it on screen, in order, live and on reload', () => {
  // NOT THE EXECUTOR ALONE. The tests above drive one executor, which proves it
  // renders but not that the reducer ever asks it to. These run the real
  // reduce() and then the real executors it names, which is the path a live
  // agent_switch actually takes.
  const SWITCH_CTX = { isActive: true, convoAgentId: 'default', toAgentExists: true, toAgentType: 'specialist', fromAgentExists: true };

  function runPipeline(msg, state) {
    const r = reduce(state, msg, SWITCH_CTX);
    for (const ef of r.effects) {
      if (ef.type === 'promote-handoff-message') promote('c1', ef);
      else if (ef.type === 'show-delegation-divider') divider('c1', ef);
    }
    return r;
  }

  function nodes() {
    return [...document.getElementById('messages').children].map((el) => ({
      kind: el.className.includes('msg-delegation') ? 'divider'
        : el.className.includes('msg-agent') ? 'agent' : 'other',
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
    }));
  }

  test('the handoff line is on screen before the arrival, with nothing streamed', () => {
    freshDom();
    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1', agentId: 'default' };
    global.getConvoState = () => ({ currentStreamingMsg: null });

    runPipeline({
      type: 'system', subtype: 'agent_switch', _conversationId: 'c1', _processId: 'p1',
      fromAgent: 'default', toAgent: 'vox',
      handoffLine: 'Handing to Vox to write the thread.',
    }, { ...createState() });

    const seen = nodes();
    const turn = seen.findIndex((n) => n.kind === 'agent');
    const arrival = seen.findIndex((n) => n.kind === 'divider');
    assert.ok(turn > -1, `the delegating agent has a visible turn: ${JSON.stringify(seen)}`);
    assert.match(seen[turn].text, /Handing to Vox to write the thread\./);
    if (arrival > -1) {
      assert.ok(turn < arrival,
        'it is said before the next agent arrives, not after, which is the order a person reads');
    }
  });

  test('what a reload draws for the same turn says the same thing', () => {
    // LIVE AND REPLAY MUST AGREE. The defect this card fixes passed a replay
    // assertion and failed a live one, so proving one says nothing about the
    // other. The transcript carries the tool summary with the line, so the live
    // message has to carry it too or the two renderings differ.
    freshDom();
    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1', agentId: 'default' };
    global.getConvoState = () => ({ currentStreamingMsg: null });

    const stored = '[Agent]\nHanding to Vox to write the thread.';
    runPipeline({
      type: 'system', subtype: 'agent_switch', _conversationId: 'c1', _processId: 'p1',
      fromAgent: 'default', toAgent: 'vox', handoffLine: stored,
    }, { ...createState() });
    const liveText = nodes().find((n) => n.kind === 'agent').text;

    freshDom();
    addAgentMsg(stored, 'default', false);
    const replayText = nodes().find((n) => n.kind === 'agent').text;

    assert.strictEqual(liveText, replayText,
      'the same turn reads identically whether it arrived live or was replayed');
  });

  test('streamed prose still wins, so nothing renders twice', () => {
    freshDom();
    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1', agentId: 'default' };
    global.getConvoState = () => ({ currentStreamingMsg: null });

    runPipeline({
      type: 'system', subtype: 'agent_switch', _conversationId: 'c1', _processId: 'p1',
      fromAgent: 'default', toAgent: 'vox', handoffLine: 'Carried line.',
    }, { ...createState(), streamingRawText: 'My own words.' });

    const turns = nodes().filter((n) => n.kind === 'agent');
    assert.strictEqual(turns.length, 1, 'one turn only');
    assert.match(turns[0].text, /My own words\./, 'and it is what the agent actually said');
  });
});

describe('every turn recorded as a plain agent message also reaches a live client', () => {
  // THE CLASS, NOT THE INSTANCE. The reported defect was one append site that
  // wrote a turn nobody was told about. Checking that one site would leave the
  // next one free to do the same, which is how this release repeatedly fixed an
  // instance and shipped the class.
  //
  // Read BY BRANCH rather than by a window of nearby lines. A fixed window
  // above each site reaches into the sibling branch, and the first version of
  // this test was exempted by a neighbouring `if (ownProse)` that had nothing
  // to do with the site it excused: deleting the real fix left it green.
  const ENGINE = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf-8');
  const CALL = "appendTranscript(convoId, 'agent'";

  // The branch a line sits in: walk back to the nearest `if`/`else if` at a
  // smaller indentation, then forward to where that indentation closes.
  function enclosingBranch(lines, at) {
    const indentOf = (l) => l.length - l.trimStart().length;
    const mine = indentOf(lines[at]);
    let head = -1;
    for (let i = at - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.trim()) continue;
      if (indentOf(l) < mine && /\bif\s*\(|\}\s*else\b/.test(l)) { head = i; break; }
      if (indentOf(l) < mine) break;
    }
    if (head === -1) return { guard: '', body: lines[at] };
    const headIndent = indentOf(lines[head]);
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) continue;
      if (indentOf(l) <= headIndent) { end = i; break; }
    }
    return { guard: lines[head], body: lines.slice(head, end).join('\n') };
  }

  test('each site either requires streamed text or hands the text to the client', () => {
    const lines = ENGINE.split('\n');
    const sites = [];
    lines.forEach((line, i) => {
      const at = line.indexOf(CALL);
      if (at === -1) return;
      // A typed entry (for example 'routing') is bookkeeping, not a turn, and
      // is deliberately invisible. Looked for AFTER the role argument, because
      // `'agent'` is itself a quoted word.
      if (/'[a-z]+'/.test(line.slice(at + CALL.length))) return;
      sites.push({ line: i + 1, text: line.trim(), ...enclosingBranch(lines, i) });
    });
    assert.ok(sites.length >= 5,
      `sanity: the engine was read and has plain agent append sites, found ${sites.length}`);

    const unexplained = sites.filter((s) => {
      // Its own guard requires the agent to have produced text, which the
      // streaming path has already put on screen.
      if (/responseText|ownProse/.test(s.guard)) return false;
      // Or its own branch hands the text to the client.
      if (/liveHandoffText\s*=\s*(?!null)\w/.test(s.body)) return false;
      return true;
    });
    assert.deepStrictEqual(unexplained.map((s) => s.line), [],
      'a turn written to the transcript with nothing sending it live is invisible until reload: '
      + JSON.stringify(unexplained.map((s) => ({ line: s.line, guard: s.guard.trim() })), null, 1));
  });
});
