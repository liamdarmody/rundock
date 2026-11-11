'use strict';
// A saved Code-mode rule, applied by the server through the real hook, with
// no window open.
//
// In Code mode the hook judges a shell command and sends its verdict with the
// request. A push to the repository's default branch Asks once: a saved
// answer under its own rule key, Bash:git-push:default-branch, answers it,
// and a legacy binary key such as Bash:git, which every git command shares,
// never does. This suite proves both through the hook itself, against a
// repository whose origin's default branch is main, rather than with a
// verdict written by hand: the verdict the hook draws is the one the router
// decides on, and that decision is recorded as it is made.
//
// HOW IT IS DRIVEN. The fixture is a development machine in miniature,
// built outside every temp folder and git working tree
// (test/helpers/code-mode-fixture.js), whose workspace is in Code mode. The
// server is opened on that workspace, answers are saved and revoked as the
// window saves them, with add_tool_allow and remove_tool_allow, and the
// window is closed before the hook is run. A turn is held on the workspace's
// answer-file guard for the conversation the hook's token names, as every
// Claude turn is held, so the saved answers are live.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const F = require('../helpers/code-mode-fixture.js');
const guard = require('../../lib/workspace/answer-file-guard.js');
const config = require('../../lib/config.js');
const P = require('../../public/permissions.js');

const TIMEOUT_MS = 1500;
const HOUR = 60 * 60 * 1000;
// The conversation the fixture's hook token is issued to (hookEnv).
const CONVO = 'code-mode-test';
const COMMAND = 'git push origin main';
const RULE = 'Bash:git-push:default-branch';

const root = F.outsideTempRoot();
let world = null;

// EVERY DECISION THE ROUTER MAKES, as it makes it: the risk, the key, the
// saved set it was given, the hook's verdict and the answer. The router asks
// the module this suite requires, so the wrapper sees exactly what it sees.
const decided = [];
const realDecide = P.decidePermission;

async function noWindow() {
  assert.ok(await h.waitUntil(() => h.internal.wss.clients.size === 0, { timeout: 3000 }), 'no window is connected');
}
async function throughWindow(message, settled, label) {
  const window = await h.connect();
  try {
    const since = window.messages.length;
    window.send(message);
    const { msg } = await window.waitFor(settled, { since, label });
    return msg;
  } finally {
    window.close();
    await noWindow();
  }
}
const save = (key) => throughWindow({ type: 'add_tool_allow', key }, (m) => m.type === 'tool_allows' && m.tools.includes(key), `saved ${key}`);
const revoke = (key) => throughWindow({ type: 'remove_tool_allow', key }, (m) => m.type === 'tool_allows' && !m.tools.includes(key), `revoked ${key}`);

let seq = 0;
// The real hook, spawned as the runtime spawns it, with the fixture's Code-mode
// environment and this server's port, asked about the push from inside the
// repository.
function push() {
  const input = {
    session_id: `saved-code-mode-${process.pid}-${++seq}`, transcript_path: '', permission_mode: 'acceptEdits',
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: COMMAND }, cwd: world.app,
  };
  return F.runHook(F.hookEnv(world, { port: h.port }), input);
}
const pushesDecided = () => decided.filter((d) => d.command === COMMAND);
const outcomes = () => {
  const dir = path.join(world.ws, '.rundock', 'state');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^events-.*\.jsonl$/.test(n))
    .flatMap((n) => h.readAppendedLog(path.join(dir, n)))
    .filter((e) => e && e.e === 'permission' && e.conv === CONVO).map((e) => e.d);
};

describe('a saved Code-mode rule, through the real hook with no window', { skip: root.skip }, () => {
  let turn = null;
  before(async () => {
    world = F.buildWorld(root.dir);
    await h.boot({ workspace: false, env: { RUNDOCK_PERMISSION_TIMEOUT_MS: String(TIMEOUT_MS) } });
    h.internal.stopScheduler();
    h.internal.setWorkspace(world.ws);
    assert.strictEqual(config.getWorkspace(), world.ws, 'the Code-mode workspace is open');
    P.decidePermission = (risk, key, saved, verdict) => {
      const answer = realDecide(risk, key, saved, verdict);
      decided.push({ risk, key, saved: saved ? [...saved].sort() : null, verdict: verdict || null, answer, command: null });
      return answer;
    };
    turn = guard.acquireAnswerFileGuard(world.ws, () => {}, { intervalMs: HOUR, convoId: CONVO });
  });
  after(async () => {
    P.decidePermission = realDecide;
    if (turn) turn.release();
    await h.shutdown();
    fs.rmSync(root.dir, { recursive: true, force: true });
  });

  // The decision a push reached, read from the wrapper: the last one made
  // since `from`, with the push's own key.
  const lastSince = (from) => {
    const made = decided.slice(from).filter((d) => d.verdict && d.verdict.rule === RULE);
    for (const d of made) d.command = COMMAND;
    return made[made.length - 1] || null;
  };

  test('with its own rule saved, the push is answered at once: the hook\'s Asks-once verdict reaches the router, and the saved rule allows it', async () => {
    await save(RULE);
    try {
      const from = decided.length;
      const started = Date.now();
      const out = await push();
      assert.strictEqual(out.decision, 'allow', `the push was not answered: ${out.raw}`);
      assert.ok(Date.now() - started < TIMEOUT_MS, 'answered before any card could time out');
      const d = lastSince(from);
      assert.ok(d, 'the router decided on the hook\'s verdict');
      assert.strictEqual(d.verdict.verdict, 'asks-once', JSON.stringify(d.verdict));
      assert.strictEqual(d.verdict.rule, RULE);
      assert.strictEqual(d.key, RULE, 'the key is the verdict\'s rule');
      assert.ok(d.saved.includes(RULE), 'the saved set holds the rule');
      assert.deepStrictEqual(d.answer, { action: 'allow', reason: 'always-allowed' });
      assert.ok(await h.waitUntil(() => outcomes().length >= 1, { timeout: 3000 }), 'the outcome is recorded');
      assert.deepStrictEqual(outcomes(), [{ tool: 'Bash', decision: 'allow', reason: 'always-allowed' }]);
    } finally {
      await revoke(RULE);
    }
  });

  test('with only the binary key Bash:git saved, the same push cards and times out: the key every git command shares never answers an Asks-once', async () => {
    assert.strictEqual(P.toolAllowKey('Bash', { command: COMMAND }), 'Bash:git', 'the binary key this command falls under');
    await save('Bash:git');
    try {
      const before = outcomes().length;
      const from = decided.length;
      const out = await push();
      assert.strictEqual(out.decision, 'deny', `the binary key answered the push: ${out.raw}`);
      const d = lastSince(from);
      assert.ok(d, 'the router decided on the hook\'s verdict');
      assert.strictEqual(d.verdict.verdict, 'asks-once', JSON.stringify(d.verdict));
      assert.strictEqual(d.verdict.rule, RULE);
      assert.ok(d.saved.includes('Bash:git') && !d.saved.includes(RULE), 'the saved set holds the binary key and not the rule');
      assert.deepStrictEqual(d.answer, { action: 'card' }, 'the decision was a card');
      assert.ok(await h.waitUntil(() => outcomes().length > before, { timeout: 3000 }), 'the outcome is recorded');
      assert.deepStrictEqual(outcomes().slice(before), [{ tool: 'Bash', decision: 'timeout' }], 'it waited on a card nobody answered');
    } finally {
      await revoke('Bash:git');
    }
  });
});
