'use strict';
// Keychain commands, end to end: the real permission hook spawned the way the
// runtime spawns it, the real server relaying its request, and the real chat
// view deciding whether to ask and drawing the card, answered by pressing the
// card's own buttons.
//
// A shell command that reads or changes an item in the Mac's Keychain asks
// every time, with Allow and Deny only, and is refused when Rundock cannot be
// asked. The command sandbox lets every command reach the Keychain service,
// because the runtime signs in through it, so this card is the only thing
// between an agent and the sign-in tokens kept there. The same commands are
// graded in process in test/unit/keychain-commands.test.js.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { JSDOM } = require('jsdom');

const h = require('../helpers/harness.js');
const RP = require('../../public/permissions.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const CONVO = 'keychain-approvals';
const SVC = 'example-service';
const K = `security find-generic-password -w -s ${SVC}`;
const SENTENCE = 'This reads or changes a password or key stored in your Mac\'s Keychain, where sign-in tokens are kept.';
const REFUSED = 'Rundock server unreachable. This reads or changes a password or key stored in your Mac\'s Keychain, '
  + 'and it is never done without asking, so it was refused rather than approved on your behalf.';
// The refusal for a line that also holds something else that cannot be undone.
const refusedFor = also => (also ? `${REFUSED} Part of it also cannot be undone.` : REFUSED);
const MODES = ['code', 'notes'];
// The Keychain and `security` are the Mac's. On any other host the hook grades
// a command of that name as it always has, and that is what is asserted there.
const MAC = process.platform === 'darwin';

// Each subcommand that asks.
const ASKS = [
  `find-generic-password -w -s ${SVC}`,
  `find-generic-password -g -s ${SVC}`,
  `find-generic-password -s ${SVC}`,
  'find-internet-password -w -s example.com',
  'find-internet-password -g -s example.com',
  'find-internet-password -s example.com',
  'find-certificate -p -c example',
  'find-certificate -c example',
  'dump-keychain',
  'export -k example.keychain -t identities -f pkcs12 -o example.p12',
  'export-identity',
  `delete-generic-password -s ${SVC}`,
  'delete-internet-password -s example.com',
  'delete-keychain example.keychain',
  `add-generic-password -a someone -s ${SVC} -w example-value`,
  'add-internet-password -a someone -s example.com -w example-value',
  `set-generic-password-partition-list -S apple-tool: -s ${SVC}`,
  'set-key-partition-list -S apple-tool: -k example-value',
  'unlock-keychain -p example-value',
  'set-keychain-settings -t 3600',
  'create-keychain -p example-value example.keychain',
  'import example.p12 -k example.keychain',
  'authorizationdb read system.privilege.admin',
  'list-keychains -s example.keychain',
  '-i',
].map(args => `security ${args}`);

// What only displays, graded as it always has been.
const DISPLAYS = [
  'security list-keychains',
  'security default-keychain',
  'security show-keychain-info',
  'security verify-cert -c example.pem',
  'security find-identity -v -p codesigning',
];

// Every place in a line the command can sit.
const POSITIONS = [
  ['in a chain', `cd src && ${K}`],
  ['in a pipe', `echo ${SVC} | ${K}`],
  ['in a subshell', `(${K})`],
  ['in a substitution', `TOKEN=$(${K})`],
  ['after sudo', `sudo ${K}`, 'elevation'],
  ['after nice', `nice -n 10 ${K}`],
  ['after time', `time ${K}`],
  ['through xargs', `echo ${SVC} | xargs security find-generic-password -w -s`],
  ['after env VAR=', `env LANG=C ${K}`],
  ['by its full path', `/usr/bin/security find-generic-password -w -s ${SVC}`],
  ['after command', `command ${K}`],
  ['inside bash -c', `bash -c "${K}"`],
  ['inside sh -c', `sh -c '${K}'`],
  ['in a here-document fed to a shell', `bash <<EOF\n${K}\nEOF`],
  ['through xargs and sudo', `echo ${SVC} | xargs sudo security find-generic-password -w -s`, 'elevation'],
  ['after nice and sudo', `nice sudo ${K}`, 'elevation'],
];

let client;
let chat;
let settings;
let dom;
const sent = [];

before(async () => {
  await h.boot();
  client = await h.connect();
  dom = new JSDOM('<!doctype html><div id="messages"></div><div id="tool-allows-block"></div>'
    + '<div id="approvals-dock" hidden><span class="approvals-dock-count"></span><div class="approvals-dock-list"></div></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.userScrolledUp = false;
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.RundockPermissions = require('../../public/permissions.js');
  global.RundockChatMarkup = require('../../public/chat-markup.js');
  global.serverPlatform = 'darwin';
  global.workspaceMode = 'knowledge';
  global.activeConversation = { id: CONVO };
  global.unread = { markPermission() {}, resolvePermission() {} };
  global.updateUnreadBadge = () => {};
  global.renderConvoList = () => {};
  global.ws = { readyState: 1, send: (s) => { sent.push(JSON.parse(s)); client.ws.send(s); } };
  chat = require('../../public/views/chat.js');
  global.setStandingToolAllows = chat.setStandingToolAllows;
  settings = require('../../public/views/settings.js');
});
after(async () => {
  await h.shutdown();
  if (dom) dom.window.close();
});

// The real hook, given one Bash call on stdin. `port` is Rundock's by default;
// a closed one stands for Rundock not running.
function runHook(command, { mode, port = h.port, convo = CONVO }) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      RUNDOCK: '1',
      RUNDOCK_PORT: String(port),
      RUNDOCK_WORKSPACE: h.workspaceDir,
      RUNDOCK_CONVO_ID: convo,
      RUNDOCK_HOOK_TOKEN: h.hookToken(convo || null),
      RUNDOCK_EXTRA_DIRS: '',
      // Git as a fresh install has it, whatever this machine's own settings.
      GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1',
    };
    if (mode === 'code') env.RUNDOCK_CODE_MODE = '1';
    else delete env.RUNDOCK_CODE_MODE;
    const proc = spawn(process.execPath, [HOOK], { cwd: h.workspaceDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', () => {
      try {
        const o = JSON.parse(out).hookSpecificOutput || {};
        resolve({ decision: o.permissionDecision, reason: o.permissionDecisionReason });
      } catch (e) { reject(new Error(`hook output unparseable: ${out}`)); }
    });
    proc.stdin.end(JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
      session_id: 's-keychain', cwd: h.workspaceDir,
    }));
  });
}

// One Bash call the whole way round, up to the point a person would act.
async function request(command, { mode }) {
  const since = client.messages.length;
  const sentBefore = sent.length;
  let alone = null;
  const done = runHook(command, { mode });
  done.then((r) => { alone = r; }, () => {});
  const arrived = () => client.messages.slice(since)
    .find((m) => m.type === 'control_request' && m.request && m.request.input && m.request.input.command === command);
  await h.waitUntil(() => alone || arrived());
  const msg = arrived();
  if (!msg) return { asked: false, hook: alone };
  chat.handlePermissionRequest(msg, msg._conversationId);
  const rule = sent.slice(sentBefore).find((m) => m.type === 'permission_response' && m.requestId === msg.request_id);
  const card = document.getElementById(`perm-${msg.request_id}`);
  const buttons = card ? [...card.querySelectorAll('[data-perm-action]')].map((b) => b.dataset.permAction) : null;
  const context = card ? (card.querySelector('.permission-context') || {}).textContent : null;
  const allowLabel = card ? card.querySelector('[data-perm-action="allow"]').textContent : null;
  return { asked: true, answeredByRule: !!rule, card, buttons, context, allowLabel, msg, done };
}

async function press(r, action) {
  assert.ok(r.card, 'there is a card to press');
  r.card.querySelector(`[data-perm-action="${action}"]`).click();
  return r.done;
}

// Asked with Allow and Deny only, saying why, and refused when denied. `also`
// is the other reason the line always asks, kept beside the Keychain.
async function assertAsks(command, mode, also) {
  const r = await request(command, { mode });
  assert.strictEqual(r.asked, true, `${command}: sent to a card rather than run`);
  assert.strictEqual(r.answeredByRule, false, `${command}: no saved answer answers it`);
  const v = r.msg.request.code_mode_verdict;
  assert.deepStrictEqual({ verdict: v.verdict, reason: v.reason, also: v.also && v.also.reason }, { verdict: 'always-asks', reason: 'keychain', also }, command);
  assert.deepStrictEqual(r.buttons, ['allow', 'deny'], `${command}: Allow and Deny only`);
  assert.strictEqual(r.allowLabel, 'Allow once');
  assert.ok(r.context.includes(SENTENCE), `${command}: the card says why: ${r.context}`);
  assert.strictEqual((await press(r, 'deny')).decision, 'deny');
  return r;
}

// As it was before: in Notes mode a card with Always allow on offer, answered
// here with `action`; in Code mode no card at all.
async function assertAsBefore(command, mode, action = 'deny') {
  const r = await request(command, { mode });
  if (mode === 'code') {
    assert.strictEqual(r.asked, false, `${command}: runs in Code mode`);
    assert.deepStrictEqual(r.hook, { decision: 'allow', reason: 'Auto-approved: workspace is in Code mode' });
    return r;
  }
  assert.strictEqual(r.asked, true, command);
  assert.strictEqual(r.answeredByRule, false, command);
  assert.deepStrictEqual(r.buttons, ['allow', 'always', 'deny'], `${command}: an ordinary card`);
  assert.ok(!r.context || !r.context.includes(SENTENCE), command);
  assert.strictEqual((await press(r, action)).decision, action === 'deny' ? 'deny' : 'allow');
  return r;
}

// A repository in the workspace whose drafts/ holds a file git has never saved.
function repositoryWithUnsavedWork() {
  const dir = path.join(h.workspaceDir, 'proj');
  if (fs.existsSync(path.join(dir, '.git'))) return;
  fs.mkdirSync(path.join(dir, 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme\n');
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  for (const args of [['init', '-q'], ['add', 'README.md'], ['commit', '-q', '-m', 'start']]) execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'drafts', 'plan.md'), 'not saved anywhere\n');
}

// A port nothing listens on: Rundock has quit, or never answered.
async function closedPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

for (const mode of MODES) {
  const Mode = mode === 'code' ? 'Code mode' : 'Notes mode';
  if (!MAC) {
    describe(`${Mode}: on a host that is not a Mac, security is graded as before`, () => {
      for (const command of [K, 'security dump-keychain', `bash -c "${K}"`]) test(command, () => assertAsBefore(command, mode));
    });
    continue;
  }

  describe(`${Mode}: each Keychain subcommand asks every time, with Allow and Deny only`, () => {
    for (const command of ASKS) test(command, () => assertAsks(command, mode));
  });

  describe(`${Mode}: wherever the command sits in the line`, () => {
    for (const [where, command, also] of POSITIONS) test(where, () => assertAsks(command, mode, also));
  });

  describe(`${Mode}: a Keychain read beside a delete of work git has never saved`, () => {
    const LOST = 'This deletes files git has never saved: drafts/plan.md would be lost for good.';
    for (const command of [`cd proj && rm -rf drafts && ${K}`, `cd proj && ${K} && rm -rf drafts`]) {
      test(command, async () => {
        repositoryWithUnsavedWork();
        const r = await assertAsks(command, mode, 'unsaved-work');
        assert.ok(r.context.includes(`${SENTENCE} ${LOST}`), `the card names both: ${r.context}`);
        assert.deepStrictEqual(await runHook(command, { mode, port: await closedPort() }), { decision: 'deny', reason: refusedFor(true) });
      });
    }
  });

  describe(`${Mode}: what only displays is graded as before`, () => {
    for (const command of DISPLAYS) test(command, () => assertAsBefore(command, mode));
  });

  describe(`${Mode}: a Keychain command that also names a folder outside`, () => {
    test('offers no folder to remember', async () => {
      const outside = path.join(__dirname, '..', 'fixtures', 'example.keychain-db');
      const r = await request(`${K} ${outside}`, { mode });
      assert.strictEqual(r.msg.request.boundary, true, 'a crossing, as before');
      assert.strictEqual(r.msg.request.grant_dir, null, 'no folder named on the request');
      assert.deepStrictEqual(r.buttons, ['allow', 'deny']);
      assert.ok(r.context.includes(SENTENCE), r.context);
      assert.strictEqual((await press(r, 'deny')).decision, 'deny');
    });
  });

  describe(`${Mode}: no saved Always allow answers it`, () => {
    test('whichever word the line starts with', async () => {
      const lines = [[K], ...POSITIONS.map(([, c, also]) => [c, also])];
      chat.setStandingToolAllows(['Bash:security', ...lines.map(([c]) => RP.toolAllowKey('Bash', { command: c }))]);
      try {
        for (const [command, also] of lines) await assertAsks(command, mode, also);
      } finally { chat.setStandingToolAllows([]); }
    });
  });

  describe(`${Mode}: when Rundock cannot be asked`, () => {
    test('every Keychain command is refused, and the agent is told why', async () => {
      const port = await closedPort();
      for (const [command, also] of [...ASKS.map(c => [c]), ...POSITIONS.map(([, c, a]) => [c, a])]) {
        assert.deepStrictEqual(await runHook(command, { mode, port }), { decision: 'deny', reason: refusedFor(also) }, command);
      }
    });
    test('what only displays carries on as before', async () => {
      const port = await closedPort();
      const before = mode === 'code'
        ? { decision: 'allow', reason: 'Auto-approved: workspace is in Code mode' }
        : { decision: 'allow', reason: 'Rundock server unreachable.' };
      for (const command of DISPLAYS) assert.deepStrictEqual(await runHook(command, { mode, port }), before, command);
    });
  });

  describe(`${Mode}: in sequence`, () => {
    test('denied, then the agent tries again: it asks again', async () => {
      await assertAsks(K, mode);
      const again = await request(K, { mode });
      assert.deepStrictEqual(again.buttons, ['allow', 'deny']);
      assert.strictEqual((await press(again, 'allow')).decision, 'allow');
    });

    test('-w after a Deny on -g asks, and a listing afterwards is graded as before', async () => {
      await assertAsks(`security find-generic-password -g -s ${SVC}`, mode);
      await assertAsks(`security find-generic-password -w -s ${SVC}`, mode);
      await assertAsBefore('security list-keychains', mode);
    });
  });
}

// The workspace's saved answers, written as a person's earlier "Always allow"
// clicks left them, then read back the way a reload reads them.
function saveAnswers(tools) {
  const file = path.join(h.workspaceDir, '.rundock', 'permissions.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { /* none saved yet */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...data, allowedTools: tools }, null, 2));
}
async function reloadSavedAnswers() {
  const since = client.messages.length;
  client.send({ type: 'get_tool_allows' });
  const { msg } = await client.waitFor((m) => m.type === 'tool_allows', { since, label: 'the saved answers' });
  settings.toolAllowsArrived(msg);
  return msg.tools;
}

describe('Notes mode: an Always allow saved for security', { skip: !MAC && 'only a Mac has the Keychain; the host check above covers this one' }, () => {
  test('from a listing card answers the next listing, and never a Keychain read', async () => {
    saveAnswers([]);
    await reloadSavedAnswers();
    const since = client.messages.length;
    await assertAsBefore('security list-keychains', 'notes', 'always');
    await client.waitFor((m) => m.type === 'tool_allows' && m.tools.includes('Bash:security'), { since, label: 'the rule saved' });

    const listing = await request('security list-keychains', { mode: 'notes' });
    assert.strictEqual(listing.answeredByRule, true, 'the saved rule answers what it was saved for');
    assert.strictEqual((await listing.done).decision, 'allow');

    for (const command of [K, `security dump-keychain`, `security find-generic-password -s ${SVC}`]) await assertAsks(command, 'notes');
  });

  test('in the workspace\'s saved answers, read back after a reload, never answers a Keychain read', async () => {
    saveAnswers(['Bash:security', 'Bash:sudo', 'Bash:bash', 'Bash:echo']);
    assert.ok((await reloadSavedAnswers()).includes('Bash:security'));
    for (const [command, also] of [[K], [`sudo ${K}`, 'elevation'], [`bash -c "${K}"`], [`echo ${SVC} | ${K}`]]) await assertAsks(command, 'notes', also);
    saveAnswers([]);
    await reloadSavedAnswers();
  });
});
