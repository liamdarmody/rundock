'use strict';
// THE CARD A CREDENTIAL FILE RAISES, HOWEVER IT IS SPELLED, against the real
// server and the browser's own card code.
//
// test/unit/secret-reach.test.js proves the hook asks, with a secret card, for
// a credential file named after a `cd` or by a glob. What a person can do with
// that card is decided further on: the server relays the request to the
// browser, the browser draws the card and its buttons, and the server keeps
// whatever the answer says to keep. A secret card offers no folder to remember
// and no standing allow, and no answer, however it is sent, makes a later
// request for the file go unasked. Each of those is asserted here on the
// request the real hook sent through the real server, drawn by the code the
// browser runs.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { JSDOM } = require('jsdom');

const h = require('../helpers/harness.js');
const { canonicalize } = require('../../scripts/permission-hook.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const CONVO = 'secret-reach';
const MODES = [['Notes mode', {}], ['Code mode', { RUNDOCK_CODE_MODE: '1' }]];
const SPELLINGS = ['cd ~/.claude && cat .credentials.json', 'cat ~/.claude/.cred*',
  // The folder that holds it, handed to a program that reads all of it.
  'grep -r token ~/.claude', 'cd ~/.claude && tar czf - .'];
const POSIX = { skip: process.platform === 'win32' && 'the home folder is read from HOME here' };

let client;
let chat;
let dom;
let home;
let credentials;
let boundary;
let workingFolders;
const sent = [];

before(async () => {
  await h.boot();
  client = await h.connect();
  // The harness's own temporary home, which the server and every hook share.
  home = os.homedir();
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
  credentials = canonicalize(path.join(home, '.claude', '.credentials.json'));
  boundary = require('../../lib/workspace/boundary.js');
  workingFolders = require('../../lib/workspace/working-folders.js');

  // The browser, as test/unit/boundary-card.test.js builds it. Its socket is a
  // recorder: an answer the card code sends is relayed to the server by hand.
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
  if (dom) dom.window.close();
  await h.shutdown();
});

function runHook(command, env = {}, tool = 'Bash', input = { command }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [HOOK], {
      cwd: h.workspaceDir,
      env: {
        ...process.env,
        RUNDOCK: '1',
        RUNDOCK_PORT: String(h.port),
        RUNDOCK_WORKSPACE: h.workspaceDir,
        RUNDOCK_CONVO_ID: CONVO,
        RUNDOCK_HOOK_TOKEN: h.hookToken(CONVO),
        RUNDOCK_CODE_MODE: '',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', () => {
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`hook output unparseable: ${out}`)); }
    });
    proc.stdin.end(JSON.stringify({ tool_name: tool, tool_input: input, session_id: 's-secret-reach' }));
  });
}
const decisionOf = (out) => (out.hookSpecificOutput ? out.hookSpecificOutput.permissionDecision : null);
const isCard = (m) => m.type === 'control_request' && m.request;
const secretOf = (request) => (request.crossings || []).find(c => c && c.path === credentials && c.secret === true);

// The request reaching the browser, as the app hands it to the card code.
function draw(msg) {
  global.activeConversation = { id: CONVO };
  document.getElementById('messages').innerHTML = '';
  global.pendingPermissions.clear();
  sent.length = 0;
  chat.handlePermissionRequest(msg, CONVO);
  return document.getElementById('messages').innerHTML;
}
function answer(msg, extra) {
  client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: CONVO, ...extra });
}
async function secretCardFor(command, env, label) {
  const since = client.messages.length;
  const pending = runHook(command, env);
  const { msg } = await client.waitFor(isCard, { since, label });
  assert.ok(secretOf(msg.request), `${label}: the card names the credential file as a secret`);
  return { msg, pending };
}

describe('a secret card reached by a relative name or a glob', () => {
  for (const [label, env] of MODES) {
    for (const command of SPELLINGS) {
      test(`${label}: ${command} offers neither a folder grant nor an always-allow, and keeps neither when sent one`, POSIX, async () => {
        const { msg, pending } = await secretCardFor(command, env, `${label}: ${command}`);
        assert.strictEqual(msg.request.grant_dir, null, 'the server offers no folder to remember');

        // A standing allow for this very command, and for every shell command,
        // must not answer it.
        const key = RundockPermissions.verdictAllowKey(msg.request.code_mode_verdict) || chat.toolAllowKey('Bash', msg.request.input || { command });
        chat.setStandingToolAllows([key, 'Bash', 'Bash(*)']);
        let html;
        try { html = draw(msg); } finally { chat.setStandingToolAllows([]); }
        assert.strictEqual(sent.length, 0, 'not answered from the standing allows');
        assert.match(html, /credential file for your Claude account/, 'the card is drawn, worded as a secret one');
        assert.doesNotMatch(html, /Always allow this folder/, 'no folder to remember');
        assert.doesNotMatch(html, /data-perm-action="always"/, 'no standing allow');

        // Sent anyway, the way no card offers: allowed, with the whole runtime
        // folder to keep.
        answer(msg, { allow: true, card: true, grantDir: path.join(home, '.claude') });
        assert.strictEqual(decisionOf(await pending), 'allow', 'that one request is allowed');

        // The same command again still asks, as a secret, whatever was kept.
        const next = await secretCardFor(command, env, `${label}: ${command}, asked again`);
        answer(next.msg, { allow: false });
        assert.strictEqual(decisionOf(await next.pending), 'deny');
      });
    }
  }
});

describe('the sequences that need the real server', () => {
  for (const [label, env] of MODES) {
    test(`${label}: the retry, after a refusal, raises the same card, and the refusal kept nothing`, POSIX, async () => {
      const command = 'cd ~/.claude && cat .credentials.json';
      const grants = boundary.readBoundaryGrants();
      const folders = workingFolders.readWorkingFolders();
      const first = await secretCardFor(command, env, `${label}: first`);
      answer(first.msg, { allow: false });
      assert.strictEqual(decisionOf(await first.pending), 'deny');
      assert.deepStrictEqual(boundary.readBoundaryGrants(), grants, 'no folder grant was stored');
      assert.deepStrictEqual(workingFolders.readWorkingFolders(), folders, 'no working folder was added');

      const second = await secretCardFor(command, env, `${label}: retry`);
      assert.deepStrictEqual(second.msg.request.crossings, first.msg.request.crossings, 'the same card');
      answer(second.msg, { allow: false });
      assert.strictEqual(decisionOf(await second.pending), 'deny');
    });

    test(`${label}: the most common next step, after the card is allowed once, a free read in the same folder raises no card`, POSIX, async () => {
      const card = await secretCardFor('cd ~/.claude && cat .credentials.json', env, `${label}: the read`);
      answer(card.msg, { allow: true, card: true });
      assert.strictEqual(decisionOf(await card.pending), 'allow');

      const since = client.messages.length;
      const pending = runHook('cd ~/.claude && ls', env);
      if (env.RUNDOCK_CODE_MODE) {
        // Code mode runs it without asking the server at all.
        assert.strictEqual(decisionOf(await pending), 'allow');
        await h.delay(200);
        assert.ok(!client.messages.slice(since).some(isCard), 'nothing was asked');
        return;
      }
      // Notes mode hands every shell command to the browser, which answers a
      // read like this one itself, without drawing a card.
      const { msg } = await client.waitFor(isCard, { since, label: `${label}: the free read` });
      assert.ok(!secretOf(msg.request), 'not a secret card');
      const html = draw(msg);
      assert.strictEqual(html, '', 'no card is drawn');
      assert.strictEqual(sent.length, 1, 'the browser answered it');
      assert.strictEqual(sent[0].allow, true);
      client.send(sent[0]);
      assert.strictEqual(decisionOf(await pending), 'allow');
    });
  }
});

// A CREDENTIAL FILE THAT IS A LINK arrives at the server at the path it leads
// to, which no registry entry names. The hook, holding the name it was reached
// by, tags it secret, and a stored grant on the folder it leads into must not
// answer for it. The same file read by its own path is an ordinary file there,
// as it is on main, and the grant covers it.
describe('a credential file that is a link, against a grant on where it leads', () => {
  for (const [label, env] of MODES) {
    test(`${label}: the grant does not answer for the credential file, and still covers the file by its own path`, POSIX, async () => {
      const file = path.join(home, '.claude', '.credentials.json');
      const store = fs.mkdtempSync(path.join(path.dirname(home), 'link-store-'));
      const target = canonicalize(path.join(store, 'credentials.json'));
      const saved = fs.readFileSync(file);
      const answers = boundary.boundaryPermissionsPath();
      const kept = fs.existsSync(answers) ? fs.readFileSync(answers) : null;
      fs.writeFileSync(target, '{}');
      fs.rmSync(file);
      fs.symlinkSync(target, file);
      try {
        boundary.addBoundaryGrant(store);
        // The Read tool's request is one a stored grant can answer, so the
        // server's own check is what keeps this card. The shell's never is.
        for (const [tool, input] of [['Read', { file_path: file }], ['Bash', { command: 'cat ~/.claude/.credentials.json' }]]) {
          const since = client.messages.length;
          const pending = runHook(null, env, tool, input);
          const first = await Promise.race([pending.then(out => ({ out })), client.waitFor(isCard, { since, timeout: 4000, label: `${label}: ${tool}` }).catch(() => null)]);
          assert.ok(first && first.msg, `${tool}: the browser is asked, not answered from the grant`);
          const { msg } = first;
          const crossing = (msg.request.crossings || []).find(c => c && c.path === target);
          assert.ok(crossing && crossing.secret === true, `${tool}: the card names where the link leads, as a secret`);
          assert.strictEqual(msg.request.grant_dir, null, `${tool}: no folder is offered to remember`);
          assert.match(draw(msg), /credential file for your Claude account/, `${tool}: drawn as a secret card`);
          answer(msg, { allow: false });
          assert.strictEqual(decisionOf(await pending), 'deny');
        }

        // By its own path it is an ordinary file, as on main (whose whole
        // answer for it is pinned in test/unit/secret-reach-on-main.test.js).
        const from = client.messages.length;
        const own = runHook(`cat ${target}`, env);
        const first = await Promise.race([own.then(out => ({ out })), client.waitFor(isCard, { since: from, label: `${label}: by its own path` }).catch(() => null)]);
        if (first && first.msg) {
          assert.ok(!(first.msg.request.crossings || []).some(c => c && c.secret), 'not a secret card');
          assert.doesNotMatch(draw(first.msg), /credential file for your Claude account/, 'not worded as one');
          answer(first.msg, { allow: false });
        }
        await own;
      } finally {
        fs.rmSync(file);
        fs.writeFileSync(file, saved);
        if (kept === null) fs.rmSync(answers, { force: true }); else fs.writeFileSync(answers, kept);
        fs.rmSync(store, { recursive: true, force: true });
      }
    });
  }
});

// A STORED GRANT OVER THE RUNTIME FOLDER DOES NOT ANSWER A READ OF ALL OF IT.
// The grant is kept as the server keeps any, over `~/.claude` and over home
// itself, and the real hook asks the real server. A recursive read of the
// folder still reaches the browser as a secret card rather than being let
// through, and the same command sent again is not answered by the grant
// either.
describe('a stored grant over a runtime folder, against a read of everything in it', () => {
  const READS = ['grep -r token ~/.claude', 'cd ~/.claude && rg -e token', 'find -L ~/.claude -exec cat {} +', 'env -u FOO rg token ~/.claude',
    // A copy into it, which can replace the credential file.
    'echo .credentials.json | cpio -pu ~/.claude'];
  for (const [label, env] of MODES) {
    test(`${label}: the grant answers neither the read nor the same read again`, POSIX, async () => {
      const answers = boundary.boundaryPermissionsPath();
      const kept = fs.existsSync(answers) ? fs.readFileSync(answers) : null;
      try {
        boundary.addBoundaryGrant(path.join(home, '.claude'));
        boundary.addBoundaryGrant(home);
        const grants = boundary.readBoundaryGrants();
        assert.ok(boundary.boundaryGrantCovers(credentials), 'sanity: the stored grant reaches the credential file');
        for (const command of READS) {
          for (const attempt of ['asked', 'asked again']) {
            const since = client.messages.length;
            const pending = runHook(command, env);
            const first = await Promise.race([pending.then(out => ({ out })), client.waitFor(isCard, { since, timeout: 4000, label: `${label}: ${command}` }).catch(() => null)]);
            assert.ok(first && first.msg, `${command}, ${attempt}: the browser is asked, not answered from the grant`);
            assert.ok(secretOf(first.msg.request), `${command}, ${attempt}: the card names the credential file as a secret`);
            assert.strictEqual(first.msg.request.grant_dir, null, `${command}, ${attempt}: no folder is offered to remember`);
            assert.match(draw(first.msg), /credential file for your Claude account/, `${command}, ${attempt}: drawn as a secret card`);
            answer(first.msg, { allow: false });
            assert.strictEqual(decisionOf(await pending), 'deny', `${command}, ${attempt}: refused, as the card was`);
          }
        }
        assert.deepStrictEqual(boundary.readBoundaryGrants(), grants, 'the stored grants are as they were');
      } finally {
        if (kept === null) fs.rmSync(answers, { force: true }); else fs.writeFileSync(answers, kept);
      }
    });
  }
});

// NOTHING ELSE GAINS A CARD, AS A PERSON SEES IT. Each command that must keep
// its answer goes from the real hook through the real server to the browser's
// card code, and what happens is compared with what happens to main's hook's
// request for the same command: whether the browser is asked, whether a card
// is drawn and how it is worded, what it offers to remember, whether the
// browser answers it itself, and the hook's final answer. A card that is drawn
// is refused.
//
// The expected values are test/fixtures/secret-reach-card-on-main.json,
// recorded by running this describe against main's hook. The server and the
// browser code these commands pass through are not changed for them:
//
//   git show origin/main:scripts/permission-hook.js > scripts/.main-hook.js
//   RUNDOCK_RECORD_HOOK="$PWD/scripts/.main-hook.js" node --test --test-name-pattern "as a person sees it" test/integration/secret-reach-card.test.js
const RECORD = process.env.RUNDOCK_RECORD_HOOK || '';
const CARD_FIXTURE = path.join(__dirname, '..', 'fixtures', 'secret-reach-card-on-main.json');
const CONTROLS = [
  'cat notes.md', 'ls dist', 'cat auth.json', 'cat sub/auth.json', 'cd sub && cat auth.json',
  'cd ~/.claude && ls', 'cd ~/.claude && ls projects', 'cd ~/.claude && cat settings.json', 'cat ~/.claude/settings.json',
  'ls ~/.claude/projects/*', 'cat ~/.codex/config.*',
  'cd <elsewhere> && cat .credentials.json', 'cd ~/.claude && cd <elsewhere> && cat .credentials.json',
  'cd ~/.claude && cd ./nonexistent && cat .credentials.json',
];
function runControl(command, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [RECORD || HOOK], {
      cwd: h.workspaceDir,
      env: { ...process.env, RUNDOCK: '1', RUNDOCK_PORT: String(h.port), RUNDOCK_WORKSPACE: h.workspaceDir, RUNDOCK_CONVO_ID: CONVO, RUNDOCK_HOOK_TOKEN: h.hookToken(CONVO), RUNDOCK_CODE_MODE: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`hook output unparseable: ${out}`)); } });
    proc.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 's-secret-reach' }));
  });
}
describe('nothing else gains a card, as a person sees it', () => {
  const seen = {};
  let elsewhere;
  before(() => { elsewhere = fs.mkdtempSync(path.join(path.dirname(home), 'elsewhere-')); });
  after(() => {
    fs.rmSync(elsewhere, { recursive: true, force: true });
    if (RECORD) fs.writeFileSync(CARD_FIXTURE, JSON.stringify(Object.fromEntries(Object.keys(seen).sort().map(k => [k, seen[k]])), null, 1) + '\n');
  });
  const onMain = RECORD ? {} : JSON.parse(fs.readFileSync(CARD_FIXTURE, 'utf8'));
  for (const [label, env] of MODES) {
    for (const command of CONTROLS) {
      test(`${label}: ${command}`, POSIX, async () => {
        const since = client.messages.length;
        const pending = runControl(command.split('<elsewhere>').join(elsewhere), env);
        const first = await Promise.race([pending.then(out => ({ out })), client.waitFor(isCard, { since, timeout: 4000, label: command }).catch(() => null)]);
        const got = { asked: false, drawn: false, secretWording: false, folderOffer: false, alwaysOffer: false, browserAnswer: null };
        if (first && first.msg) {
          got.asked = true;
          got.secret = (first.msg.request.crossings || []).some(c => c && c.secret);
          const html = draw(first.msg);
          got.drawn = html !== '';
          got.secretWording = /credential file for your Claude account/.test(html);
          got.folderOffer = /Always allow this folder/.test(html);
          got.alwaysOffer = /data-perm-action="always"/.test(html);
          if (sent.length) { got.browserAnswer = sent[0].allow === true; client.send(sent[0]); } else answer(first.msg, { allow: false });
        }
        got.decision = decisionOf(await pending);
        const key = `${label} | ${command}`;
        if (RECORD) { seen[key] = got; return; }
        assert.ok(onMain[key], 'measured on main');
        assert.deepStrictEqual(got, onMain[key], 'what the person sees, as on main');
      });
    }
  }
});
