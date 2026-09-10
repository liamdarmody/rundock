'use strict';
// A confirmation pill belongs to the conversation that earned it.
//
// FOUND BY HAND, NOT BY A TEST, and the reason no test caught it is worth
// keeping: every suite here drives ONE conversation. This defect only exists
// when two are in play, so a whole class of routing bug is invisible to a suite
// built the way this one is.
//
// The report: an agent was asked in one conversation to create a skill, and the
// pills "Agent updated" and "Skill created" appeared in a DIFFERENT conversation,
// the one that happened to be on screen.
//
// Not a race. The client sent save_agent and save_skill with no conversation id,
// so the server's reply had nothing to route by, and the renderer appends to
// whichever thread is displayed. It lands in the wrong place every time the
// creating conversation is not the one being looked at.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const config = require(path.join(ROOT, 'lib', 'config.js'));
const { handleSaveAgent, handleSaveSkill } = require(path.join(ROOT, 'lib', 'protocol', 'handlers', 'team.js'));

/** These handlers do nothing without a workspace, so give them a throwaway one. */
function inWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pill-routing-'));
  const original = config.getWorkspace();
  config.setWorkspace(dir);
  try { return fn(dir); } finally {
    config.setWorkspace(original);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* going anyway */ }
  }
}

function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}

describe('the reply carries the conversation that asked', () => {
  test('a saved agent is confirmed to the conversation that produced the marker', () => {
    const ws = captureWs();
    inWorkspace(() => {
      const ctx = { agents: { validateAgentSlug: () => true },
                    workspace: { isInsideWorkspace: () => true } };
      try {
        handleSaveAgent(ctx, ws, {
          type: 'save_agent', name: 'roo', content: '# Roo\n', conversationId: 'convo-A',
        });
      } catch (e) { ws.sent.push({ type: 'threw', message: String(e && e.message) }); }
    });
    const reply = ws.sent.find((m) => m.type === 'agent_saved' || m.type === 'agent_error');
    assert.ok(reply, `a reply was sent (got ${JSON.stringify(ws.sent).slice(0, 200)})`);
    assert.strictEqual(reply.conversationId, 'convo-A',
      'the reply names the conversation that asked, so the pill can be routed to it');
  });

  test('a saved skill is confirmed to the conversation that produced the marker', () => {
    const ws = captureWs();
    inWorkspace(() => {
      try {
        handleSaveSkill({ agents: { validateAgentSlug: () => true },
                          workspace: { isInsideWorkspace: () => true } }, ws, {
          type: 'save_skill', name: 'hello-world-testing', content: '# Hello\n', conversationId: 'convo-A',
        });
      } catch (e) { ws.sent.push({ type: 'threw', message: String(e && e.message) }); }
    });
    const reply = ws.sent.find((m) => m.type === 'skill_saved' || m.type === 'skill_error');
    assert.ok(reply, `a reply was sent (got ${JSON.stringify(ws.sent).slice(0, 200)})`);
    assert.strictEqual(reply.conversationId, 'convo-A',
      'the reply names the conversation that asked');
  });
});

describe('the pill renders only where it belongs', () => {
  // THE REAL RULE, NOT A COPY OF IT. An earlier version of this block defined
  // its own shows() reimplementing the condition, so deleting or inverting the
  // real one in app.js would have left every assertion here green. That is the
  // "suite validating a component nothing reaches" shape this project keeps
  // finding, produced here by the test author rather than by the code.
  //
  // app.js is the page's own script and cannot be required, so the rule is
  // lifted out of its source and evaluated. If it moves or changes shape this
  // fails loudly rather than quietly testing a stale copy.
  const fs2 = require('node:fs');
  const appSrc = fs2.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const at = appSrc.indexOf('function addSystemMsgToConvo');
  assert.ok(at > -1, 'the routing helper still exists in app.js');
  const fnSrc = appSrc.slice(at, appSrc.indexOf('\n}', at) + 2);

  let shown = null;
  const sandbox = { activeConversation: null, addSystemMsg: (t) => { shown = t; } };
  // eslint-disable-next-line no-new-func
  const make = new Function('ctx', `with (ctx) { ${fnSrc}; return addSystemMsgToConvo; }`);
  const addSystemMsgToConvo = make(sandbox);

  function renders(convoId, activeId) {
    shown = null;
    sandbox.activeConversation = activeId ? { id: activeId } : null;
    addSystemMsgToConvo('a pill', convoId, false);
    return shown !== null;
  }

  test('a confirmation for another conversation does not render here', () => {
    assert.strictEqual(renders('convo-A', 'convo-B'), false,
      'a skill created in A must not announce itself in B, which is the reported defect');
  });

  test('a confirmation for the conversation on screen still renders', () => {
    assert.strictEqual(renders('convo-A', 'convo-A'), true, 'the ordinary case is unchanged');
  });

  test('a reply with no conversation attached is still shown', () => {
    assert.strictEqual(renders(null, 'convo-A'), true,
      'some replies are about the workspace rather than a conversation, and dropping '
      + 'them silently would trade a visible bug for an invisible one');
  });

  test('a reply arriving with nothing on screen is dropped', () => {
    // Written the other way round at first, from a hand-copy of this rule that
    // claimed it rendered. The real one does not, and the copy hid that: the
    // finding that replaced the copy with the real function surfaced it on the
    // first run. Dropping is right, because with no conversation open there is
    // no thread to render into.
    assert.strictEqual(renders('convo-A', null), false,
      'a pill for a conversation nobody is looking at has nowhere to land');
  });
});

describe('the client sends what the server needs to route', () => {
  const fs2 = require('node:fs');
  const src = fs2.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

  test('marker actions carry the conversation that produced them', () => {
    assert.match(src, /MARKER_SENDS\[action\.kind\]\(action\), conversationId: convoId/,
      'the save is sent with the conversation id, or the reply has nothing to route by');
  });

  test('the confirmations go through the routing helper, not straight to the thread', () => {
    for (const kind of ['agent_saved', 'skill_saved', 'agent_deleted', 'skill_deleted', 'agent_error', 'skill_error']) {
      const at = src.indexOf("case '" + kind + "':");
      assert.ok(at > -1, kind + ' is still handled');
      const body = src.slice(at, src.indexOf('break;', at));
      assert.match(body, /addSystemMsgToConvo\(/,
        kind + ' renders through the one conversation-aware helper');
    }
  });
});

describe('a refusal routes the same way a success does', () => {
  const { handleSaveAgent, handleSaveSkill } = require(path.join(ROOT, 'lib', 'protocol', 'handlers', 'team.js'));

  // WHY THIS EXISTS SEPARATELY. The success tests above build a context where
  // validation always passes, so they can only ever take the success branch:
  // the error replies were rewritten to carry the conversation id and then
  // never executed by anything. A confirmation that routes correctly while its
  // refusal does not is worse than neither, because the failure is the message
  // a reader most needs to see in the right place.

  test('a refused agent name still names the conversation that asked', () => {
    const ws = captureWs();
    inWorkspace(() => {
      handleSaveAgent(
        { agents: { validateAgentSlug: () => false }, workspace: { isInsideWorkspace: () => true } },
        ws, { type: 'save_agent', name: 'Not A Valid Slug', content: 'x', conversationId: 'convo-A' });
    });
    const reply = ws.sent.find((m) => m.type === 'agent_error');
    assert.ok(reply, `an error reply was sent (got ${JSON.stringify(ws.sent).slice(0, 200)})`);
    assert.strictEqual(reply.conversationId, 'convo-A',
      'the refusal reaches the conversation that asked, not whichever is on screen');
  });

  test('a refused skill name does the same', () => {
    const ws = captureWs();
    inWorkspace(() => {
      handleSaveSkill(
        { agents: { validateAgentSlug: () => false }, workspace: { isInsideWorkspace: () => true } },
        ws, { type: 'save_skill', name: 'Not Valid', content: 'x', conversationId: 'convo-A' });
    });
    const reply = ws.sent.find((m) => m.type === 'skill_error');
    assert.ok(reply, `an error reply was sent (got ${JSON.stringify(ws.sent).slice(0, 200)})`);
    assert.strictEqual(reply.conversationId, 'convo-A');
  });
});
