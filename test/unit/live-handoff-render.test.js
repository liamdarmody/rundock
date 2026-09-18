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
    // UNCONDITIONAL. Guarding this on the divider existing made the ordering
    // assertion skippable: a change that stopped drawing the arrival would
    // silently take the order check with it and the test would still pass.
    assert.ok(arrival > -1, `the arrival divider is drawn too: ${JSON.stringify(seen)}`);
    assert.ok(turn < arrival,
      'it is said before the next agent arrives, not after, which is the order a person reads');
  });

  test('the live turn carries the words alone, not the transcript bookkeeping', () => {
    // MEASURED IN A BROWSER, then pinned here. A reload renders the Claude
    // session, not the transcript, so the `[Agent]` tool-summary prefix that
    // Rundock adds on the way into the transcript is absent after a reload.
    // Sending the prefixed string made the same turn read differently live and
    // reloaded, which is the divergence this card forbids. No assertion on the
    // strings alone could see it; it took looking at the two render paths.
    const ENGINE = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf-8');
    const at = ENGINE.indexOf('liveHandoffText = ');
    assert.ok(at > -1, 'sanity: the engine still decides what to send live');
    const assignments = [...ENGINE.matchAll(/liveHandoffText\s*=\s*([A-Za-z_$][\w$.]*)/g)].map((m) => m[1]);
    assert.ok(assignments.length >= 2, `sanity: both branches assign it, found ${assignments.length}`);
    for (const a of assignments) {
      assert.ok(!/withTools/i.test(a),
        `the live message must not carry the tool-summary string (${a}): a reload does not show it, `
        + 'so sending it makes the same turn read two different ways');
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

    const stored = 'Handing to Vox to write the thread.';
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

describe('a turn with nothing to say draws nothing', () => {
  // LH-5, on the document rather than on an effect list. An effect list can be
  // empty while something else still paints, and the criterion is about what a
  // person sees.
  const SWITCH_CTX = { isActive: true, convoAgentId: 'default', toAgentExists: true, toAgentType: 'specialist', fromAgentExists: true };

  test('neither prose nor a carried line leaves no bubble behind', () => {
    freshDom();
    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1', agentId: 'default' };
    global.getConvoState = () => ({ currentStreamingMsg: null });

    const r = reduce({ ...createState() }, {
      type: 'system', subtype: 'agent_switch', _conversationId: 'c1', _processId: 'p1',
      fromAgent: 'default', toAgent: 'vox',
    }, SWITCH_CTX);
    for (const ef of r.effects) {
      if (ef.type === 'promote-handoff-message') promote('c1', ef);
      else if (ef.type === 'show-delegation-divider') divider('c1', ef);
    }

    const agentTurns = [...document.getElementById('messages').children]
      .filter((el) => el.className.includes('msg-agent'));
    assert.deepStrictEqual(agentTurns.map((el) => el.textContent), [],
      'an empty bubble is worse than no bubble, and the routing entry stays invisible');
  });

  test('a whitespace-only carried line likewise draws nothing', () => {
    freshDom();
    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1', agentId: 'default' };
    global.getConvoState = () => ({ currentStreamingMsg: null });

    const r = reduce({ ...createState() }, {
      type: 'system', subtype: 'agent_switch', _conversationId: 'c1', _processId: 'p1',
      fromAgent: 'default', toAgent: 'vox', handoffLine: '   \n  ',
    }, SWITCH_CTX);
    for (const ef of r.effects) {
      if (ef.type === 'promote-handoff-message') promote('c1', ef);
      else if (ef.type === 'show-delegation-divider') divider('c1', ef);
    }
    const agentTurns = [...document.getElementById('messages').children]
      .filter((el) => el.className.includes('msg-agent'));
    assert.deepStrictEqual(agentTurns.map((el) => el.textContent), []);
  });
});

describe('a turn blocked mid-delegation is still shown to the person', () => {
  const CTX = { isActive: true, convoAgentId: 'default' };

  function runAgentTurn(msg, state) {
    const r = reduce(state, msg, CTX);
    for (const ef of r.effects) if (ef.type === 'promote-handoff-message') promote('c1', ef);
    return r;
  }

  test('the blocked agent\'s own words appear as its turn', () => {
    freshDom();
    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1', agentId: 'default' };
    global.getConvoState = () => ({ currentStreamingMsg: null });

    runAgentTurn({
      type: 'system', subtype: 'agent_turn', _conversationId: 'c1', _processId: 'p1',
      _agent: 'default', text: 'I will ask Ren to pick this up instead.',
    }, { ...createState() });

    const turns = [...document.getElementById('messages').children]
      .filter((el) => el.className.includes('msg-agent'))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
    assert.strictEqual(turns.length, 1, 'exactly one turn on screen');
    assert.match(turns[0], /I will ask Ren to pick this up instead\./);
  });

  test('a turn that already streamed is not drawn again', () => {
    freshDom();
    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1', agentId: 'default' };
    global.getConvoState = () => ({ currentStreamingMsg: null });

    runAgentTurn({
      type: 'system', subtype: 'agent_turn', _conversationId: 'c1', _processId: 'p1',
      _agent: 'default', text: 'Already on screen.',
    }, { ...createState(), streamingRawText: 'Already on screen.' });

    const turns = [...document.getElementById('messages').children]
      .filter((el) => el.className.includes('msg-agent'));
    assert.deepStrictEqual(turns.map((el) => el.textContent), [],
      'streamed text is already drawn, and drawing it again is the duplicate this guards');
  });
});

describe('the blocked turn reads the same live and after a reload', () => {
  // ST-7. The defect this whole area keeps producing is a turn that is right in
  // one rendering and wrong or absent in the other, so each claim is made twice
  // and the two are compared rather than each being checked alone.
  const CTX = { isActive: true, convoAgentId: 'default' };

  test('the same words, whichever way the turn arrived', () => {
    const words = 'Ana is the right person, let me pull her in.';

    freshDom();
    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1', agentId: 'default' };
    global.getConvoState = () => ({ currentStreamingMsg: null });
    const r = reduce({ ...createState() }, {
      type: 'system', subtype: 'agent_turn', _conversationId: 'c1', _processId: 'p1',
      _agent: 'default', text: words,
    }, CTX);
    for (const ef of r.effects) if (ef.type === 'promote-handoff-message') promote('c1', ef);
    const live = [...document.getElementById('messages').children]
      .filter((el) => el.className.includes('msg-agent'))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());

    freshDom();
    addAgentMsg(words, 'default', false);
    const replayed = [...document.getElementById('messages').children]
      .filter((el) => el.className.includes('msg-agent'))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());

    assert.deepStrictEqual(live, replayed,
      'a blocked turn reads identically whether it arrived live or was replayed');
    assert.strictEqual(live.length, 1, 'and it is one turn, not none and not two');
  });

  test('a marker in a blocked turn is not shown to the person', () => {
    freshDom();
    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1', agentId: 'default' };
    global.getConvoState = () => ({ currentStreamingMsg: null });
    const r = reduce({ ...createState() }, {
      type: 'system', subtype: 'agent_turn', _conversationId: 'c1', _processId: 'p1',
      _agent: 'default', text: 'I will route through Penn. <!-- RUNDOCK:RETURN -->',
    }, CTX);
    for (const ef of r.effects) if (ef.type === 'promote-handoff-message') promote('c1', ef);
    const shown = [...document.getElementById('messages').children]
      .filter((el) => el.className.includes('msg-agent'))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
    assert.strictEqual(shown.length, 1);
    assert.doesNotMatch(shown[0], /RUNDOCK:/,
      'a handback marker is plumbing, and every other render path strips it');
    assert.match(shown[0], /I will route through Penn\./);
  });

  test('a line arriving on anything but the interception switch is ignored', () => {
    // The provenance half, on the effects the reducer will act on. A restore
    // switch names no new process, so a line riding one is not something the
    // interception computed.
    const notIntercepted = reduce({ ...createState() }, {
      type: 'system', subtype: 'agent_switch', _conversationId: 'c1',
      fromAgent: 'vox', toAgent: 'default', handoffLine: 'SPOOFED',
    }, { isActive: true, convoAgentId: 'default', toAgentExists: true, toAgentType: 'orchestrator', fromAgentExists: true });
    const promoted = notIntercepted.effects.filter((e) => e.type === 'promote-handoff-message');
    assert.deepStrictEqual(promoted, [],
      'no process id means no forward delegation, so there is no computed line to honour');
  });
});

describe('every branch that suppresses the envelope delivers what it suppressed', () => {
  // THE RULE, KEYED ON THE SUPPRESSION ITSELF.
  //
  // Measured in engine-live-delivery.test.js: the engine forwards every runtime
  // line as it arrives, so a turn is delivered by default. What makes one
  // invisible is a branch that reaches `continue` in the stdout handler, which
  // skips the forward at its foot and (in both cases) kills the process, so no
  // result ever arrives. A forwarded `assistant` line does not save it: the
  // reducer produces no effects for one.
  //
  // Earlier versions of this check keyed on the append sites and on the word
  // "suppress" in a comment. The first found the innermost `if` rather than the
  // block that continues; the second was satisfied by the comment that the fix
  // itself carried, so deleting the fix deleted the evidence. Both stayed green
  // with a delivery removed. This keys on the `continue` statements, which are
  // the suppression, and there is nothing else for them to be.
  const ENGINE = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf-8');

  function suppressingBlocks() {
    const lines = ENGINE.split('\n');
    const indentOf = (l) => l.length - l.trimStart().length;
    const blocks = [];
    lines.forEach((line, i) => {
      // A TRAILING COMMENT IS STILL A CONTINUE. Requiring end-of-line missed
      // the interception's own `continue; // suppress ...`, so the rule was
      // only ever judging one of the two branches, and deleting the handoff
      // delivery left it green. Found by review, not by the mutation check,
      // because the mutation check was asking the same half-blind question.
      if (!/^\s*continue;(\s*\/\/.*)?$/.test(line)) return;
      // The block this continue ends: walk back to the nearest `if` at a
      // smaller indent, and take everything from there to here.
      const mine = indentOf(line);
      let head = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (!lines[j].trim()) continue;
        if (indentOf(lines[j]) < mine && /\bif\s*\(/.test(lines[j])) { head = j; break; }
      }
      if (head === -1) return;
      blocks.push({ line: i + 1, guard: lines[head].trim(), body: lines.slice(head, i + 1).join('\n') });
    });
    return blocks;
  }

  test('each one sends the turn it kept off the wire', () => {
    const blocks = suppressingBlocks();
    // FLOORED AT TWO, because two is what there are and a walk that finds one
    // is the failure this rule has already had once.
    assert.ok(blocks.length >= 2,
      `sanity: the interception still has branches that continue, found ${blocks.length}`);

    const silent = blocks.filter((b) => {
      // Only blocks that also end the process can strand a turn: without the
      // kill, a result still follows and carries it.
      if (!/killProcessTree/.test(b.body)) return false;
      // The handoff line rides the switch handleDelegation sends.
      if (/liveHandoffText\s*=\s*(?!null)\w/.test(b.body)) return false;
      // Or the turn is sent in its own right before the process dies.
      if (/subtype:\s*'agent_turn'/.test(b.body)) return false;
      return true;
    });

    assert.deepStrictEqual(silent.map((b) => `${b.line}: ${b.guard}`), [],
      'a branch that stops the envelope and kills the process has to send the turn itself, '
      + 'or the words are in the transcript and on nobody\'s screen until a reload');

    // WHAT THIS RULE DOES NOT CATCH, said plainly rather than left to be
    // discovered. The interception's block holds two deliveries, one for the
    // handoff line and one for prose that never streamed, so removing either
    // leaves the other satisfying the check here. Measured: deleting the
    // handoff assignment keeps this green. That delivery is held instead by
    // test/integration/handoff-line.test.js, which drives a real delegation and
    // asserts the line is on the switch, and which does redden when it goes.
    // Two tests, one per delivery, rather than one test believed to cover both.
    assert.ok(blocks.some((b) => /liveHandoffText/.test(b.body)),
      'the interception block still delivers by that name, which is what the integration test pins');
  });
});
