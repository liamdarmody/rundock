'use strict';
// A CREDENTIAL READ, ASKED THROUGH THE REAL SERVER AND DRAWN BY THE REAL CARD.
//
// The real hook, spawned the way the runtime spawns it, asks the real server,
// the server sends the card to a connected window, and the card is drawn by
// the code the browser runs. A read of each file the secrets registry names,
// from an ordinary workspace, sends the request main's hook sent, and the
// window gets the card main's got. With the workspace at the home folder,
// which holds every one of those files, main allowed the same read with
// nothing shown. It now draws a card that says the file is in the workspace
// and offers nothing to remember, which no standing allow answers and no
// answer, however it is sent, makes go unasked. It comes back to a window that
// reconnects, and once Rundock is back after refusing a read while it could
// not be asked, the read asks again.
//
// What each read sends the server, the card request the window gets, and the
// hook's answer once the card is refused, are compared field by field with
// main's: test/fixtures/credential-read-card-on-main.json, recorded by running
// this file against the hook as it was in v0.15.8:
//
//   git show v0.15.8:scripts/permission-hook.js > scripts/.main-hook.js
//   RUNDOCK_RECORD_HOOK="$PWD/scripts/.main-hook.js" node --test test/integration/credential-read-card.test.js
//
// The home folder and the workspace are written as `<home>` and `<workspace>`,
// and each request's conversation and session, which name the test's own
// conversations, are left out.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { JSDOM } = require('jsdom');

const h = require('../helpers/harness.js');
const { secretsRegistry, canonicalize } = require('../../scripts/permission-hook.js');
const { unansweredNotice } = require('../../scripts/refusal-notice.js');
const { closedPort } = require('../helpers/code-mode-fixture.js');

const RECORD = process.env.RUNDOCK_RECORD_HOOK || '';
const HOOK = RECORD || path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'credential-read-card-on-main.json');
const MODES = [['Notes mode', ''], ['Code mode', '1']];
const AT_HOME = ', workspace at home';
// The shell commands are POSIX spellings, the recorded paths are POSIX, and the
// home folder is read from HOME here.
const POSIX = { skip: process.platform === 'win32' && 'the shell commands and recorded paths here are POSIX' };
// What only the code under test can show, left out while main is recorded.
const LIVE = { skip: POSIX.skip || (RECORD ? 'main is being recorded' : false) };
const OUTSIDE = { Read: 'Wants to read outside your workspace', Bash: 'Wants to reach outside your workspace' };
const CREDENTIAL_COPY = 'This is the credential file for your Claude account. A leak here cannot be undone, so this always asks, on any access, and no grant, mode or setting can silence it.';
const REFUSAL = unansweredNotice('Rundock server unreachable. This reads a sign-in credential, and it is never done without asking, so it was refused rather than approved on your behalf.', { unattended: false });

let client;
let chat;
let dom;
let home;
let closed;
let boundary;
let workingFolders;
const sent = [];
const bodies = new Map();
const recorded = {};
const onMain = RECORD ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

before(async () => {
  await h.boot();
  client = await h.connect();
  // The harness's own temporary home, which the server and every hook share.
  home = process.env.HOME;
  for (const f of [...secretsRegistry(home), ...secretsRegistry(h.workspaceDir)]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{}\n');
  }
  closed = await closedPort();
  boundary = require('../../lib/workspace/boundary.js');
  workingFolders = require('../../lib/workspace/working-folders.js');
  // Every request the hook sends, as the server receives it, by conversation.
  h.internal.server.on('request', (req) => {
    if (req.method !== 'POST' || req.url !== '/api/permission-request') return;
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try {
        const { session_id: _s, conversation_id: convo, ...rest } = JSON.parse(b);
        bodies.set(convo, rest);
      } catch (e) { /* not a request the hook sent */ }
    });
  });

  // The browser, as test/unit/boundary-card.test.js builds it. Its socket is a
  // recorder: nothing the card code sends reaches the server.
  dom = new JSDOM('<div id="messages"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.alwaysAllowedTools = new Set();
  global.ws = { send: (s) => sent.push(JSON.parse(s)) };
  global.userScrolledUp = false;
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.RundockPermissions = require('../../public/permissions.js');
  global.RundockChatMarkup = require('../../public/chat-markup.js');
  global.serverPlatform = process.platform;
  global.workspaceMode = 'knowledge';
  chat = require('../../public/views/chat.js');
});
after(async () => {
  if (RECORD) fs.writeFileSync(FIXTURE, JSON.stringify(Object.fromEntries(Object.keys(recorded).sort().map(k => [k, recorded[k]])), null, 1) + '\n');
  if (dom) dom.window.close();
  await h.shutdown();
});

const normal = (v) => {
  let text = JSON.stringify(v);
  for (const [dir, name] of [[h.workspaceDir, '<workspace>'], [home, '<home>']]) {
    for (const spelled of [fs.realpathSync(dir), dir]) text = text.split(spelled).join(name);
  }
  return JSON.parse(text);
};
const keyOf = (label, [tool, input]) => `${label} | ${tool} | ${JSON.stringify(normal(input))}`;
const named = ([tool, input]) => `${tool} ${JSON.stringify(normal(input))}`;
const reads = (f) => [['Read', { file_path: f }], ['Bash', { command: `cat ${f}` }]];
const cardFor = (convo) => client.messages.find(m => m.type === 'control_request' && m._conversationId === convo);
let convos = 0;

// The real hook, given one tool call in a conversation of its own, as the
// runtime spawns it, under the home folder `under`.
function runHook(tool, input, { code, under, port, convo }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [HOOK], {
      cwd: h.workspaceDir,
      env: {
        ...process.env, HOME: under, USERPROFILE: under, NODE_V8_COVERAGE: '',
        RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: h.workspaceDir, RUNDOCK_CODE_MODE: code,
        RUNDOCK_CONVO_ID: convo, RUNDOCK_HOOK_TOKEN: h.hookToken(convo), RUNDOCK_EXTRA_DIRS: '',
        RUNDOCK_TEST_SEAMS: '', RUNDOCK_TEST_PLATFORM: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', () => { try { resolve(JSON.parse(out).hookSpecificOutput); } catch (e) { reject(new Error(`hook output unparseable: ${out}`)); } });
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, session_id: `s-${convo}`, cwd: h.workspaceDir }));
  });
}

// One read, start to finish: the hook asks, and a card the window gets is
// answered with `reply`. Resolves what the server received, the card request
// the window got (or null when there was none) and the hook's answer.
async function ask(tool, input, { code, under = home, port = h.port, reply = { allow: false }, onCard } = {}) {
  const convo = `credential-card-${++convos}`;
  let answer;
  let done = false;
  const pending = runHook(tool, input, { code, under, port, convo }).then((a) => { answer = a; done = true; });
  await h.waitUntil(() => done || !!cardFor(convo));
  const card = cardFor(convo) || null;
  if (card) {
    if (onCard) await onCard(card, convo);
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convo, ...reply });
  }
  await pending;
  return { convo, body: bodies.get(convo) || null, card: card ? card.request : null, answer };
}
const recordOf = ({ body, card, answer }) => normal({ body, card, answer });

// Every case, four hooks at a time.
async function each(cases, fn) {
  const out = new Array(cases.length);
  let next = 0;
  const worker = async () => { while (next < cases.length) { const i = next++; out[i] = await fn(cases[i], i); } };
  await Promise.all(Array.from({ length: Math.min(4, cases.length) }, worker));
  return out;
}

// The card reaching the browser, as the app hands it to the card code, with a
// standing allow for this tool and for every shell command in place.
function draw(msg, convo) {
  const card = msg.request;
  global.activeConversation = { id: convo };
  document.getElementById('messages').innerHTML = '';
  global.pendingPermissions.clear();
  sent.length = 0;
  const key = RundockPermissions.verdictAllowKey(card.code_mode_verdict) || chat.toolAllowKey(card.tool_name, card.input);
  chat.setStandingToolAllows([key, card.tool_name, 'Bash', 'Bash(*)']);
  try { chat.handlePermissionRequest(msg, convo); } finally { chat.setStandingToolAllows([]); }
  const el = document.getElementById('messages');
  return {
    answered: sent.length > 0,
    words: el.textContent.replace(/\s+/g, ' ').trim(),
    summary: (el.querySelector('.permission-summary') || {}).textContent,
    context: (el.querySelector('.permission-context') || {}).textContent,
    detail: (el.querySelector('.permission-detail') || {}).textContent,
    risk: (el.querySelector('.permission-card') || { className: '' }).className,
    buttons: [...el.querySelectorAll('button[data-perm-action]')].map(b => `${b.dataset.permAction}: ${b.textContent.trim()}`),
  };
}

describe('from an ordinary workspace, a credential read asks as it did on main', POSIX, () => {
  for (const [label, code] of MODES) {
    test(`${label}: Read and cat of each credential file send main's request, draw main's card and take its answer`, async () => {
      const cases = secretsRegistry(home).flatMap(reads);
      const got = await each(cases, ([tool, input]) => ask(tool, input, { code }));
      cases.forEach((c, i) => {
        const key = keyOf(label, c);
        if (RECORD) { recorded[key] = recordOf(got[i]); return; }
        assert.ok(onMain[key], `${named(c)}: measured on main`);
        assert.ok(got[i].card && got[i].card.boundary === true && got[i].card.crossings.some(x => x.secret), `${named(c)}: one secret card`);
        assert.deepStrictEqual(recordOf(got[i]), onMain[key], `${named(c)}: the request, the card and the answer, as on main`);
      });
    });
    test(`${label}: the card says it reaches a credential outside the workspace and offers nothing to remember`, LIVE, async () => {
      for (const c of secretsRegistry(home).flatMap(reads)) {
        let drawn;
        await ask(c[0], c[1], { code, onCard: (card, convo) => { drawn = draw(card, convo); } });
        assert.strictEqual(drawn.answered, false, `${named(c)}: not answered from the standing allows`);
        assert.strictEqual(drawn.summary, OUTSIDE[c[0]], `${named(c)}: worded as outside`);
        assert.ok(drawn.context.startsWith(CREDENTIAL_COPY), `${named(c)}: worded as a credential: ${drawn.context}`);
        assert.deepStrictEqual(drawn.buttons.map(b => b.split(':')[0]), ['allow', 'deny'], `${named(c)}: a one-off answer and nothing to remember`);
        assert.doesNotMatch(drawn.words, /Always allow/, named(c));
      }
    });
  }
});

describe('with the workspace at the home folder, a credential read asks, where main allowed it with nothing shown', POSIX, () => {
  for (const [label, code] of MODES) {
    test(`${label}${AT_HOME}: Read and cat of each credential file draw a card that says the file is in the workspace`, async () => {
      const cases = secretsRegistry(h.workspaceDir).flatMap(reads);
      const got = await each(cases, ([tool, input]) => ask(tool, input, { code, under: h.workspaceDir }));
      cases.forEach((c, i) => {
        const key = keyOf(`${label}${AT_HOME}`, c);
        if (RECORD) { recorded[key] = recordOf(got[i]); return; }
        assert.ok(onMain[key], `${named(c)}: measured on main`);
        assert.strictEqual(onMain[key].card, null, `${named(c)}: main drew no card`);
        assert.strictEqual(onMain[key].answer.permissionDecision, 'allow', `${named(c)}: main allowed it`);
        const file = canonicalize(c[1].file_path || c[1].command.slice('cat '.length));
        const { credential, resolved_path, grant_dir, boundary: crossing, crossings } = got[i].card || {};
        assert.deepStrictEqual({ credential, resolved_path, grant_dir, crossing, crossings }, { credential: true, resolved_path: file, grant_dir: null, crossing: undefined, crossings: undefined }, `${named(c)}: a credential card naming the file, with no folder to remember`);
        assert.strictEqual(got[i].body.credential, true, `${named(c)}: the hook asked about a credential`);
        assert.strictEqual(got[i].body.resolved_path, file, `${named(c)}: by its path`);
        assert.strictEqual(got[i].answer.permissionDecision, 'deny', `${named(c)}: refused, as the card was`);
      });
    });
    test(`${label}${AT_HOME}: the card names the file where it is, in the workspace, and offers nothing to remember`, LIVE, async () => {
      for (const c of secretsRegistry(h.workspaceDir).flatMap(reads)) {
        let drawn;
        await ask(c[0], c[1], { code, under: h.workspaceDir, onCard: (card, convo) => { drawn = draw(card, convo); } });
        const file = canonicalize(c[1].file_path || c[1].command.slice('cat '.length));
        assert.strictEqual(drawn.answered, false, `${named(c)}: not answered from the standing allows`);
        assert.strictEqual(drawn.summary, 'Wants to read a sign-in credential in your workspace', named(c));
        assert.ok(drawn.context.startsWith(CREDENTIAL_COPY), `${named(c)}: worded as a credential: ${drawn.context}`);
        assert.strictEqual(drawn.detail, file, `${named(c)}: the file it reads`);
        assert.doesNotMatch(drawn.words, /outside/, `${named(c)}: not called a place outside the workspace`);
        assert.match(drawn.risk, /risk-high/, named(c));
        assert.deepStrictEqual(drawn.buttons, ['allow: Allow', 'deny: Deny'], `${named(c)}: a one-off answer and nothing to remember`);
      }
    });
    test(`${label}${AT_HOME}: an allow is that one read only, however it is sent, and keeps nothing`, LIVE, async () => {
      const [tool, input] = reads(secretsRegistry(h.workspaceDir)[0])[0];
      const answers = boundary.boundaryPermissionsPath();
      const kept = fs.existsSync(answers) ? fs.readFileSync(answers) : null;
      const folders = workingFolders.readWorkingFolders();
      try {
        // Sent the way no card offers: allowed, with the whole workspace, which
        // is the home folder, to keep.
        const first = await ask(tool, input, { code, under: h.workspaceDir, reply: { allow: true, card: true, grantDir: h.workspaceDir } });
        assert.strictEqual(first.answer.permissionDecision, 'allow', 'that one read is allowed');
        const again = await ask(tool, input, { code, under: h.workspaceDir });
        assert.deepStrictEqual(again.card, first.card, 'the same read asks again, with the same card');
        assert.strictEqual(again.answer.permissionDecision, 'deny');
      } finally {
        if (kept === null) fs.rmSync(answers, { force: true }); else fs.writeFileSync(answers, kept);
        workingFolders.writeWorkingFolders(folders);
      }
    });
    test(`${label}${AT_HOME}: a window that reconnects gets the card again, and its answer stands`, LIVE, async () => {
      const [tool, input] = reads(secretsRegistry(h.workspaceDir)[1])[1];
      let second;
      let replayed;
      const got = await ask(tool, input, { code, under: h.workspaceDir, onCard: async (card) => {
        second = await h.connect();
        ({ msg: replayed } = await second.waitFor(m => m.type === 'control_request' && m.request_id === card.request_id, { label: 'the card, sent again' }));
      } });
      second.close();
      // The replay is rebuilt from what the server kept, which has never
      // included Code mode's verdict for any card.
      const { code_mode_verdict: _v, ...asked } = got.card;
      assert.deepStrictEqual(replayed.request, asked, 'the same card request, the credential and its path included');
      assert.strictEqual(replayed._conversationId, got.convo);
      assert.strictEqual(got.card.credential, true);
      assert.strictEqual(got.answer.permissionDecision, 'deny');
    });
  }
});

describe('once Rundock is back, a credential read refused while it could not be asked draws its card again', LIVE, () => {
  for (const [label, code] of MODES) {
    test(`${label}: nothing remembers the refusal`, async () => {
      for (const c of secretsRegistry(home).flatMap(reads)) {
        const refused = await ask(c[0], c[1], { code, port: closed });
        assert.deepStrictEqual(refused.answer, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REFUSAL }, `${named(c)}: refused while unreachable`);
        assert.strictEqual(refused.card, null);
        const again = await ask(c[0], c[1], { code });
        assert.deepStrictEqual(recordOf(again), onMain[keyOf(label, c)], `${named(c)}: main's card, once Rundock is back`);
      }
    });
    test(`${label}${AT_HOME}: nothing remembers the refusal`, async () => {
      for (const c of secretsRegistry(h.workspaceDir).flatMap(reads)) {
        const first = await ask(c[0], c[1], { code, under: h.workspaceDir });
        const refused = await ask(c[0], c[1], { code, under: h.workspaceDir, port: closed });
        assert.deepStrictEqual(refused.answer, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REFUSAL }, `${named(c)}: refused while unreachable`);
        const again = await ask(c[0], c[1], { code, under: h.workspaceDir });
        assert.ok(again.card && again.card.credential === true, `${named(c)}: a card once Rundock is back`);
        assert.deepStrictEqual({ body: again.body, card: again.card }, { body: first.body, card: first.card }, `${named(c)}: the request and card a first read draws`);
      }
    });
  }
});
