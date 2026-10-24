'use strict';
// What the persona journeys ask of the page before they act.
//
// They slept a fixed 1.5 seconds after signing in, and half a second after
// starting a conversation with an agent. Inside the release gate, on a loaded
// machine, the persona step failed once and passed alone: the socket can still
// be connecting when the journey sends on it, and the page can still be
// waiting for the roster that names the agent, in which case the client opens
// a conversation with the first agent it knows instead. These tests drive the
// real helpers against a page that is slow in exactly those ways.
//
// THE FAKE PAGE RUNS EACH FUNCTION THE WAY A BROWSER DOES: its source, in a
// context of its own holding only the client's globals, as page.evaluate
// sends it. A function that reached for anything in this file would fail here
// as it would in the page.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pageReady;
test('load the module', async () => {
  pageReady = await import('../../scripts/smoke/page-ready.mjs');
  assert.strictEqual(typeof pageReady.startConversationWith, 'function');
});

const OPEN = 1;
const CONNECTING = 0;

// A page with the client's globals. `startConversation` behaves as the
// client's does: an id it does not know opens a conversation with the first
// agent it knows.
function fakePage({ ws = { readyState: OPEN }, workspace = '/w', agents = [], start } = {}) {
  const calls = [];
  const globals = { ws, currentWorkspacePath: workspace, agents, activeConversation: null };
  globals.window = globals;
  globals.startConversation = (id) => {
    calls.push({ id, roster: globals.agents.map((a) => a.id) });
    const agent = start ? start(globals, id) : (globals.agents.find((a) => a.id === id) || globals.agents[0]);
    globals.activeConversation = { agentId: agent.id };
  };
  const context = vm.createContext(globals);
  return {
    globals,
    calls,
    evaluate: async (fn, arg) => vm.runInContext(`(${fn.toString()})(${JSON.stringify(arg)})`, context),
  };
}

const later = (ms, change) => new Promise((resolve) => setTimeout(() => { change(); resolve(); }, ms));
const FAST = { timeout: 2000, interval: 10 };

describe('the page is connected before a journey sends anything', () => {
  test('a socket still connecting is not connected', async () => {
    assert.strictEqual(await pageReady.pageConnected(fakePage({ ws: { readyState: CONNECTING } })), false);
  });

  test('a page with no socket yet is not connected', async () => {
    assert.strictEqual(await pageReady.pageConnected(fakePage({ ws: null })), false);
  });

  test('an open socket on a page the server has not told its workspace is not connected yet', async () => {
    assert.strictEqual(await pageReady.pageConnected(fakePage({ workspace: null })), false);
  });

  test('an open socket on a page showing its workspace is connected', async () => {
    assert.strictEqual(await pageReady.pageConnected(fakePage()), true);
  });

  test('waiting resolves once a slow page connects, and not before', async () => {
    const page = fakePage({ ws: { readyState: CONNECTING }, workspace: null });
    const started = Date.now();
    const [ready] = await Promise.all([
      pageReady.waitForPage(page, FAST),
      later(150, () => { page.globals.ws.readyState = OPEN; page.globals.currentWorkspacePath = '/w'; }),
    ]);
    assert.strictEqual(ready, true);
    assert.ok(Date.now() - started >= 140, 'it waited for the page');
  });

  test('a page that never connects is reported as false, not waited on forever', async () => {
    assert.strictEqual(await pageReady.waitForPage(fakePage({ ws: { readyState: CONNECTING } }), { timeout: 60, interval: 10 }), false);
  });
});

describe('a conversation is started with the agent asked for, or not at all', () => {
  const GUIDE = { id: 'rundock-guide' };
  const COS = { id: 'chief-of-staff' };

  test('it waits for the roster to name the agent, then starts the conversation with it', async () => {
    const page = fakePage({ agents: [GUIDE] });
    const [result] = await Promise.all([
      pageReady.startConversationWith(page, COS.id, FAST),
      later(120, () => { page.globals.agents = [GUIDE, COS]; }),
    ]);
    assert.deepStrictEqual(result, { ok: true, detail: '' });
    assert.deepStrictEqual(page.calls, [{ id: COS.id, roster: [GUIDE.id, COS.id] }], 'started once, after the roster named it');
    assert.strictEqual(page.globals.activeConversation.agentId, COS.id);
  });

  test('an agent the page never hears of is reported, and no conversation is started', async () => {
    const page = fakePage({ agents: [GUIDE] });
    const result = await pageReady.startConversationWith(page, COS.id, { timeout: 60, interval: 10 });
    assert.strictEqual(result.ok, false);
    assert.match(result.detail, /roster never held chief-of-staff/);
    assert.deepStrictEqual(page.calls, [], 'nothing was started with another agent in its place');
    assert.strictEqual(page.globals.activeConversation, null);
  });

  test('a start that opens a conversation with another agent is reported, naming both', async () => {
    const page = fakePage({ agents: [GUIDE, COS], start: (g) => g.agents[0] });
    const result = await pageReady.startConversationWith(page, COS.id, FAST);
    assert.strictEqual(result.ok, false);
    assert.match(result.detail, /with chief-of-staff was asked for, and one with rundock-guide opened/);
  });
});

describe('the persona journeys ask the page rather than sleep', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'smoke', 'personas.mjs'), 'utf8');

  test('after signing in, the page is waited for, not slept on', () => {
    assert.ok(SRC.includes("import { waitForPage, startConversationWith } from './page-ready.mjs';"));
    assert.ok(SRC.includes('if (!(await waitForPage(page))) {'), 'the journey waits for the page to connect');
    assert.ok(!SRC.includes('waitForTimeout(1500)'), 'the fixed sleep after signing in is gone');
  });

  test('every conversation is started through the helper, with the agent it names', () => {
    assert.ok(!SRC.includes('window.startConversation('), 'no conversation is started straight in the page');
    assert.ok(SRC.includes("await startConversationWith(page, 'chief-of-staff');"));
    assert.ok(SRC.includes("await startConversationWith(page, 'rundock-guide');"));
    assert.ok(!SRC.includes('waitForTimeout(500)'), 'the half-second sleeps after starting one are gone');
  });
});
