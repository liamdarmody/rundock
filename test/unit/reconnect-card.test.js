'use strict';
// The card shown when Claude Code's session has expired, rendered by the real
// card code under jsdom, driven through every state it can reach.
//
// One press reconnects: the desktop app opens the console through its main
// process, a browser running from source asks the server to. The person types
// nothing. The card cannot tell by itself when they have finished, because the
// only thing that can is a real turn, so it waits for "I've reconnected" and
// checks then. Where no console can be opened it shows the steps to run.
//
// The card never says "sign in": every state's words are checked for it.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

let chat, dom, calls;
before(() => {
  dom = new JSDOM('<div id="messages"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.userScrolledUp = false;
  global.activeConversation = { id: 'c1' };
  chat = require('../../public/views/chat.js');
});
after(() => { if (dom) dom.window.close(); });

// Answers for the two routes and the desktop channel, recorded as they are asked.
let answers;
beforeEach(() => {
  calls = [];
  answers = { reconnect: { ok: true }, connection: { connected: true }, status: 200 };
  delete dom.window.electronAPI;
  global.fetch = async (url, init) => {
    calls.push({ url, method: init && init.method });
    if (answers.reject) throw new Error('offline');
    const body = url === '/api/claude/reconnect' ? answers.reconnect : answers.connection;
    return { ok: answers.status === 200, status: answers.status, json: async () => body };
  };
});

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
function draw() {
  document.getElementById('messages').innerHTML = '';
  chat.renderAuthErrorCard('c1');
  return document.querySelector('.auth-error-card');
}
const title = (card) => card.querySelector('.auth-error-title').textContent;
const labels = (card) => [...card.querySelectorAll('button')].map((b) => b.textContent.trim());
const press = async (card, label) => {
  const b = [...card.querySelectorAll('button')].find((x) => x.textContent.trim() === label);
  assert.ok(b, `a "${label}" button, among ${JSON.stringify(labels(card))}`);
  b.click();
  await settle();
};
// No state of this card says "sign in", in its words or its attributes.
function neverSaysSignIn(card) {
  const SIGN_IN = /sign(?:ed|ing)?[\s-]*in\b/i;
  assert.doesNotMatch(card.textContent, SIGN_IN, `the card says: ${card.textContent}`);
  for (const node of card.querySelectorAll('*')) {
    for (const attr of ['title', 'aria-label']) assert.doesNotMatch(node.getAttribute(attr) || '', SIGN_IN);
  }
}

describe('ready', () => {
  test('one button reconnects, and the words say what will happen', () => {
    const card = draw();
    assert.strictEqual(title(card), 'Claude needs reconnecting');
    assert.deepStrictEqual(labels(card), ['Reconnect Claude']);
    assert.match(card.querySelector('.auth-error-foot').textContent, /A window opens and runs Claude Code for you\. You type nothing\./);
    const link = card.querySelector('.auth-error-foot a');
    assert.strictEqual(link.textContent, 'Troubleshooting');
    assert.match(link.getAttribute('href'), /^https:\/\/docs\.rundock\.ai\//);
    assert.strictEqual(link.getAttribute('rel'), 'noopener');
    neverSaysSignIn(card);
  });
});

describe('reconnecting', () => {
  test('on the desktop the main process opens the console, and the card waits', async () => {
    let asked = 0;
    dom.window.electronAPI = { reconnectClaude: async () => { asked++; return { ok: true }; } };
    const card = draw();
    await press(card, 'Reconnect Claude');
    assert.strictEqual(asked, 1);
    assert.deepStrictEqual(calls, [], 'the server is not asked to open a second window');
    assert.strictEqual(title(card), 'Waiting for Claude');
    assert.ok(card.querySelector('.auth-pulse'), 'the waiting pulse, not a spinner');
    assert.deepStrictEqual(labels(card), ['I\'ve reconnected', 'Open the window again']);
    neverSaysSignIn(card);
  });

  test('from source the server opens it', async () => {
    const card = draw();
    await press(card, 'Reconnect Claude');
    assert.deepStrictEqual(calls, [{ url: '/api/claude/reconnect', method: 'POST' }]);
    assert.strictEqual(title(card), 'Waiting for Claude');
  });

  test('"I\'ve reconnected" checks, shows it is checking, then says it worked', async () => {
    const card = draw();
    await press(card, 'Reconnect Claude');
    let release;
    const held = new Promise((r) => { release = r; });
    const realFetch = global.fetch;
    global.fetch = async (url, init) => { await held; return realFetch(url, init); };
    const b = [...card.querySelectorAll('button')].find((x) => x.textContent.trim() === 'I\'ve reconnected');
    b.click();
    await settle();
    const busy = card.querySelector('[aria-busy="true"]');
    assert.ok(busy, 'the button says it is busy while the check runs');
    assert.ok(busy.disabled);
    assert.ok(busy.querySelector('.auth-pulse'));
    neverSaysSignIn(card);
    release();
    await settle();
    assert.deepStrictEqual(calls.map((c) => c.url), ['/api/claude/reconnect', '/api/claude/connection']);
    assert.strictEqual(title(card), 'Reconnected');
    assert.ok(card.classList.contains('auth-ok'));
    assert.match(card.textContent, /Resend your message to carry on\./);
    assert.deepStrictEqual(labels(card), []);
    neverSaysSignIn(card);
  });

  test('a check that finds it still disconnected says so and waits again', async () => {
    answers.connection = { connected: false };
    const card = draw();
    await press(card, 'Reconnect Claude');
    await press(card, 'I\'ve reconnected');
    assert.strictEqual(title(card), 'Waiting for Claude');
    assert.match(card.textContent, /isn't connected yet/);
    assert.deepStrictEqual(labels(card), ['I\'ve reconnected', 'Open the window again']);
    neverSaysSignIn(card);
  });

  test('"Open the window again" opens it again', async () => {
    const card = draw();
    await press(card, 'Reconnect Claude');
    await press(card, 'Open the window again');
    assert.deepStrictEqual(calls.map((c) => c.url), ['/api/claude/reconnect', '/api/claude/reconnect']);
  });
});

describe('when the window cannot be opened', () => {
  test('Claude Code not found: says so, and Try again opens it again', async () => {
    answers.reconnect = { ok: false, reason: 'not-found' };
    const card = draw();
    await press(card, 'Reconnect Claude');
    assert.strictEqual(title(card), 'Rundock could not open the window');
    assert.ok(card.classList.contains('auth-bad'));
    assert.match(card.textContent, /Claude Code was not found on this computer\./);
    assert.ok(card.querySelector('.auth-error-foot a'), 'Troubleshooting is still there');
    neverSaysSignIn(card);
    answers.reconnect = { ok: true };
    await press(card, 'Try again');
    assert.strictEqual(title(card), 'Waiting for Claude');
  });

  test('any other failure, a refused request or no answer at all, is a failure too', async () => {
    for (const set of [{ reconnect: { ok: false, reason: 'failed' } }, { status: 401 }, { reject: true }]) {
      Object.assign(answers, set);
      const card = draw();
      await press(card, 'Reconnect Claude');
      assert.strictEqual(title(card), 'Rundock could not open the window', JSON.stringify(set));
      assert.doesNotMatch(card.textContent, /not found/, 'it does not claim a cause it does not know');
      neverSaysSignIn(card);
      answers = { reconnect: { ok: true }, connection: { connected: true }, status: 200 };
    }
  });

  test('no console on this platform: the steps to run, as plain words', async () => {
    answers.reconnect = { ok: false, reason: 'unsupported' };
    const card = draw();
    await press(card, 'Reconnect Claude');
    assert.strictEqual(title(card), 'Claude needs reconnecting');
    const steps = [...card.querySelectorAll('.auth-error-steps li')].map((li) => li.textContent);
    assert.strictEqual(steps.length, 3);
    assert.match(steps[0], /Open a terminal\./);
    assert.strictEqual(card.querySelector('.auth-error-steps code').textContent, 'claude');
    assert.match(steps[2], /log out and log back in/);
    neverSaysSignIn(card);
  });
});
