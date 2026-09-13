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
  // EVERY FILE THAT CAN WRITE A TURN, not the one the defect was reported in.
  // Scoping this to engine.js would let the next module repeat it untouched,
  // which is the same instance-shaped thinking the rule exists to stop.
  const CALL_RE = /appendTranscript\(\s*[A-Za-z_$][\w$]*\s*,\s*'agent'/;
  // SITES THAT SHARE THE DEFECT AND ARE NOT FIXED HERE. Each writes a turn
  // guarded only by responseText being non-empty, so a turn whose text arrived
  // without deltas is recorded and never sent. They belong to the
  // non-intercepted handback paths, which this card does not touch, and are
  // listed so the gap is visible rather than quietly exempted. Removing an
  // entry after fixing its site is how this list shrinks; adding one needs a
  // reason as good as this paragraph.
  // NO EXCEPTIONS, because there is nothing to except.
  //
  // Four rounds of this card argued site by site about which appends deliver
  // their turn, and kept a list of the ones that could not be settled by
  // reading. Driving the engine settled it in one run, in
  // engine-live-delivery.test.js: every runtime line is forwarded to the socket
  // as it arrives, so a turn is delivered by DEFAULT and no append site has to
  // arrange it. The only way a turn goes missing is a branch that suppresses
  // the envelope, and there is exactly one, the Agent-tool interception, which
  // suppresses it and kills the process so the delegate can take over.
  //
  // So the rule below is not "every append must deliver". It is "every branch
  // that suppresses the envelope must deliver what it suppressed".
  //
  // It has TWO members, not one, which an earlier version of this comment got
  // wrong. The second is the off-roster impersonation guard: it also ends in
  // `continue`, so an agent that tried to delegate outside its direct reports
  // has that turn's own words recorded and not sent. It is real, it is rare
  // (it needs a blocked delegation), and it needs a carrier that branch does
  // not have, since nothing hands over there. Recorded rather than rushed.
  const KNOWN_DELTA_GAPS = new Set([
    "lib/delegation/engine.js::if (entry.responseText) {",
  ]);
  function sourceFiles(dir, acc = []) {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) sourceFiles(full, acc);
      else if (name.endsWith('.js')) acc.push(full);
    }
    return acc;
  }
  const FILES = [path.join(ROOT, 'server.js'), ...sourceFiles(path.join(ROOT, 'lib'))];

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
    // No enclosing conditional at all, which is the shape of the runtime error
    // paths: a bare write inside a try, with the send beside it. The body is
    // then the immediate vicinity, or the send two lines down falls outside it
    // and the site reads as unexplained when it is not.
    if (head === -1) return { guard: '', body: lines.slice(at, at + 8).join('\n') };
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
    const sites = [];
    let scanned = 0;
    for (const file of FILES) {
      const src = fs.readFileSync(file, 'utf-8');
      if (!CALL_RE.test(src)) continue;
      scanned++;
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        const m = line.match(CALL_RE);
        if (!m) return;
        // A typed entry (for example 'routing') is bookkeeping, not a turn, and
        // is deliberately invisible. Looked for AFTER the role argument,
        // because `'agent'` is itself a quoted word.
        if (/'[a-z]+'/.test(line.slice(line.indexOf(m[0]) + m[0].length))) return;
        // The definition itself, not a call of it.
        if (/function appendTranscript/.test(line)) return;
        sites.push({
          file: path.relative(ROOT, file), line: i + 1, text: line.trim(),
          before: lines.slice(Math.max(0, i - 6), i).join('\n'),
          // The nearest callback or function header above the site, so the
          // delivery route that belongs to the whole callback is visible.
          enclosing: lines.slice(Math.max(0, i - 30), i).reverse()
            .find((l) => /onResult:\s*\(|onTurnDone:\s*\(|^function |^async function /.test(l)) || '',
          ...enclosingBranch(lines, i),
        });
      });
    }
    assert.ok(scanned >= 1, `sanity: at least one source file writes agent turns, scanned ${scanned}`);
    assert.ok(sites.length >= 5,
      `sanity: the engine was read and has plain agent append sites, found ${sites.length}`);

    // THE THREE WAYS A RECORDED TURN LEGITIMATELY REACHES A PERSON. Anything
    // else is a turn written to a file that nobody is told about.
    const unexplained = sites.filter((s) => {
      // One: it only runs when the agent produced text, which means the
      // streaming path has already drawn it. Read from the lines above as well
      // as the guard, because indentation in this codebase is not uniform and
      // a walker keyed on it alone mistook a sibling `} else {` for the guard.
      // READ FROM THE GUARD ALONE where there is one. Including the lines above
      // re-exempted the reported site via the sibling branch's `if (ownProse)`
      // and left this test green with the fix deleted, which is the third way
      // this same check has been made toothless. Measured each time by deleting
      // the fix; this is the shape that reddens.
      // A guard on responseText only explains the site when the code also
      // knows the text STREAMED. responseText is filled from deltas when they
      // arrive and from the assistant blocks when they do not, so a site that
      // reads it without consulting sawTextDelta is claiming the client saw
      // something it may never have been sent. The intercepted path consults
      // it; the sites listed below do not, and are recorded rather than
      // excused, because hiding them is how a class stays open.
      // THE ASSIGNMENT, INSIDE THE BRANCH. Reading the lines above lets a bare
      // declaration (`let liveHandoffText = null`, `const streamedToClient =
      // ...`) stand in for actually sending anything, and both of those sit
      // above every branch here. Each version of this check that looked above
      // the branch stayed green while a fix was deleted.
      if (/liveHandoffText\s*=\s*(?!null)\w/.test(s.body)) return false;
      // Only a branch that suppresses the envelope owes a delivery. Everything
      // else is carried by the forwarded stream, measured in
      // engine-live-delivery.test.js rather than argued from the source.
      if (!/continue;/.test(s.body) || !/suppress/.test(s.body)) return false;
      if (KNOWN_DELTA_GAPS.has(`${s.file}::${s.guard.trim()}`)) return false;
      // Three: it pushes the same turn down the socket beside the write, which
      // is how the runtime error paths do it.
      if (/safeSend\(/.test(s.body)) return false;
      return true;
    });
    assert.deepStrictEqual(unexplained.map((s) => `${s.file}:${s.line}`), [],
      'a turn written to the transcript with nothing sending it live is invisible until reload: '
      + JSON.stringify(unexplained.map((s) => ({ at: `${s.file}:${s.line}`, guard: s.guard.trim() })), null, 1));
  });

  test('the list of known gaps cannot hide the site this card fixes', () => {
    // A recorded exemption is a loaded gun pointed at the next reader: it is
    // only honest while it cannot be widened to cover the thing under test.
    // The intercepted handoff site must not be in it, now or later.
    const engine = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf-8').split('\n');
    const fixed = engine.findIndex((l) => /liveHandoffText\s*=\s*handoffLine/.test(l));
    assert.ok(fixed > -1, 'sanity: the fix is still in the engine');
    // The guard the handoff branch sits under may never appear in the list.
    assert.ok(![...KNOWN_DELTA_GAPS].some((k) => /handoffLine/.test(k)),
      'the branch this card fixes may never be excused by the gap list');
  });
});
