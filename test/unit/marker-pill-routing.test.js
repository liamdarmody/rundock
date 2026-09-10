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
  // The client rule, extracted by reading the source rather than booting the
  // app, because app.js is the page's own script and needs the whole page. What
  // is asserted here is the decision itself; the pill's routing through it is
  // bound below.
  function shows(reply, activeId) {
    const active = activeId ? { id: activeId } : null;
    return !(reply && reply.conversationId && active && reply.conversationId !== active.id);
  }

  test('a confirmation for another conversation does not render here', () => {
    assert.strictEqual(shows({ conversationId: 'convo-A' }, 'convo-B'), false,
      'a skill created in A must not announce itself in B, which is the reported defect');
  });

  test('a confirmation for the conversation on screen still renders', () => {
    assert.strictEqual(shows({ conversationId: 'convo-A' }, 'convo-A'), true,
      'the ordinary case is unchanged');
  });

  test('a reply with no conversation attached is still shown', () => {
    assert.strictEqual(shows({ }, 'convo-A'), true,
      'some replies are about the workspace rather than a conversation, and dropping '
      + 'them silently would trade a visible bug for an invisible one');
  });

  test('a reply arriving with nothing on screen is still shown', () => {
    assert.strictEqual(shows({ conversationId: 'convo-A' }, null), true,
      'there is no wrong thread to land in when no thread is open');
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
    for (const kind of ['agent_saved', 'skill_saved', 'agent_deleted']) {
      const at = src.indexOf("case '" + kind + "':");
      assert.ok(at > -1, kind + ' is still handled');
      const body = src.slice(at, src.indexOf('break;', at));
      assert.match(body, /addSystemMsgFor\(d,/,
        kind + ' renders through the conversation-aware helper');
    }
  });
});
