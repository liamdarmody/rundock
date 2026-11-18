'use strict';
// A CREDENTIAL FILE NAMED WITH QUOTES OR A VARIABLE, against the real server.
//
// test/unit/joined-path-words.test.js proves the hook asks, with a secret
// card, for a credential file however the line quotes its path, and for one
// reached through a variable. What happens to that request is decided further
// on, by the server: with no window open it answers a low-risk read itself and
// applies the answers a person saved, and a working folder can cover a path.
// None of that may answer for a credential file. Each case here runs the real
// hook against the real server, as the runtime runs it.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const route = require('../helpers/permission-route.js');
const guard = require('../../lib/workspace/answer-file-guard.js');
const config = require('../../lib/config.js');
const boundary = require('../../lib/workspace/boundary.js');
const workingFolders = require('../../lib/workspace/working-folders.js');
const { refusalNotice } = require('../../scripts/refusal-notice.js');
const { canonicalize, secretsRegistry } = require('../../scripts/permission-hook.js');

const AGENT = 'runner';
const TIMEOUT_MS = 1500;
const HOUR = 60 * 60 * 1000;
const ALWAYS = { allow: true, reason: 'always-allowed' };
const MODES = [['Notes mode', {}], ['Code mode', { RUNDOCK_CODE_MODE: '1' }]];
const POSIX = process.platform === 'win32' ? 'the home folder and quotes are read the POSIX way here' : false;

// [command, the file below home it reads]
const READS = [
  ['cat "$HOME"/.claude/.credentials.json', '.claude/.credentials.json'],
  ['cat "$HOME/.claude"/.credentials.json', '.claude/.credentials.json'],
  ['cat "${HOME}/.claude"/.credentials.json', '.claude/.credentials.json'],
  ['cat ~/.claude/".credentials.json"', '.claude/.credentials.json'],
  ["cat ~/.claude/'.credentials'.json", '.claude/.credentials.json'],
  ['cat ~/.claude/.cred""entials.json', '.claude/.credentials.json'],
  ['cat "$HOME/.codex"/auth.json', '.codex/auth.json'],
  ['cat ~/.codex/"auth.json"', '.codex/auth.json'],
  ['H=~/.claude; cat $H/.credentials.json', '.claude/.credentials.json'],
  ['H=~; cat $H/.claude/.credentials.json', '.claude/.credentials.json'],
  ['cat $(echo ~)/.claude/.credentials.json', '.claude/.credentials.json'],
];
const WRITES = [
  ['echo x >> ~/.claude/"settings.json"', '.claude/settings.json'],
  ["echo x >> ~/.claude/'settings'.json", '.claude/settings.json'],
  ['echo x > ~/.claude/".credentials.json"', '.claude/.credentials.json'],
];

let home;
const recorder = route.routerRecorder();
const { broadcasts, filed } = recorder;

before(async () => {
  await h.boot({
    agents: { runner: agentFile({ name: AGENT, type: 'specialist', order: 1 }) },
    env: { RUNDOCK_PERMISSION_TIMEOUT_MS: String(TIMEOUT_MS) },
  });
  h.internal.stopScheduler();
  // The harness's home is a temporary folder: every credential file the hook
  // knows, the runtime's settings, and an ordinary file, there.
  home = os.homedir();
  for (const file of [...secretsRegistry(home), path.join(home, '.claude', 'settings.json'), path.join(home, 'notes.txt')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
  }
  fs.writeFileSync(path.join(h.workspaceDir, 'notes.md'), '# notes\n');
  recorder.install();
});
after(async () => {
  recorder.uninstall();
  await h.shutdown();
});

const { noWindow, ask, bash, runHook, events } = route;
const file = (rel) => canonicalize(path.join(home, ...rel.split('/')));
const cardsOf = (convo) => broadcasts.filter((m) => m.type === 'control_request' && m._conversationId === convo);
const timedOut = (requestId) => broadcasts.some((m) => m.type === 'permission_timeout' && m.requestId === requestId);
const answeredWithoutCard = (convo) => events().filter((e) => e.e === 'permission' && e.conv === convo && e.d && (e.d.reason === 'read-only' || e.d.reason === 'always-allowed'));

// Asked with no window open: refused at the timeout, after one card that names
// `rel`, and never answered by the server on its own.
async function cardsAndTimesOut(command, rel, convo, env, { secret }) {
  const out = await runHook('Bash', { command }, { convo, env });
  assert.strictEqual(out.permissionDecision, 'deny', `${command}: ${JSON.stringify(out)}`);
  assert.strictEqual(out.permissionDecisionReason, refusalNotice('timeout', 'Bash', { unattended: false }), `${command}: refused as unanswered`);
  const cards = cardsOf(convo);
  assert.strictEqual(cards.length, 1, `${command}: one card was raised`);
  const request = cards[0].request;
  assert.strictEqual(request.boundary, true, `${command}: graded as a crossing: ${JSON.stringify(request)}`);
  const crossing = (request.crossings || []).find((c) => c && c.path === file(rel));
  assert.ok(crossing, `${command}: the card names ~/${rel}: ${JSON.stringify(request.crossings)}`);
  if (secret) {
    assert.strictEqual(crossing.secret, true, `${command}: as a secret`);
    assert.strictEqual(request.grant_dir, null, `${command}: no folder offered`);
  }
  assert.deepStrictEqual(filed.filter((f) => f.convo === convo).map((f) => f.id), [cards[0].request_id], `${command}: it waited on the card`);
  assert.ok(timedOut(cards[0].request_id), `${command}: and it timed out`);
  assert.deepStrictEqual(answeredWithoutCard(convo), [], `${command}: never answered as a read or from a saved answer`);
}

describe('with no window open, each spelling waits for its card', { skip: POSIX, concurrency: true }, () => {
  before(() => noWindow());
  READS.forEach(([command, rel], i) => {
    test(`Notes mode: ${command} is not answered as a read`, async () => {
      await cardsAndTimesOut(command, rel, `jpw-read-${i}`, {}, { secret: true });
    });
  });
  WRITES.forEach(([command, rel], i) => {
    test(`Notes mode: ${command} cards as a write to ~/${rel}`, async () => {
      await cardsAndTimesOut(command, rel, `jpw-write-${i}`, {}, { secret: rel.endsWith('.credentials.json') });
    });
  });
});

// A TURN, HELD ON THE ANSWER-FILE GUARD as every agent's turn holds it, so the
// server applies the saved answers (see saved-answers-without-window.test.js).
async function holdTurn(convoIds) {
  const workspace = config.getWorkspace();
  assert.ok(await h.waitUntil(() => !guard.answerFilesWatched(workspace), { timeout: 5000 }), 'no other turn is running');
  const turns = convoIds.map((convoId) => guard.acquireAnswerFileGuard(workspace, () => {}, { intervalMs: HOUR, convoId }));
  assert.ok(guard.answerFilesWatched(workspace), 'the guard watches the workspace');
  return { release: () => { for (const t of turns) t.release(); } };
}
async function throughWindow(message, settled) {
  const window = await h.connect();
  try {
    const since = window.messages.length;
    window.send(message);
    await window.waitFor((m) => m.type === 'tool_allows' && settled(m.tools), { since, label: `the saved answers after ${message.type}` });
  } finally {
    window.close();
  }
  await noWindow();
}

describe('a saved allow for the command, and home and the runtime folder as working folders, answer none of them', { skip: POSIX, concurrency: true }, () => {
  const KEYS = ['Bash:cat', 'Bash:echo'];
  const convoOf = (label, i) => `jpw-saved-${label.split(' ')[0].toLowerCase()}-${i}`;
  const convos = MODES.flatMap(([label]) => READS.map((_, i) => convoOf(label, i)));
  let turn;
  let folders;
  let extraDirs;
  before(async () => {
    await noWindow();
    folders = workingFolders.readWorkingFolders();
    const kept = workingFolders.writeWorkingFolders([home, path.join(home, '.claude')]);
    assert.deepStrictEqual(kept.length, 2, `both folders are kept: ${JSON.stringify(kept)}`);
    extraDirs = workingFolders.workingFoldersEnv(workingFolders.effectiveWorkingFolders());
    turn = await holdTurn([...convos, 'jpw-saved-live']);
    for (const key of KEYS) await throughWindow({ type: 'add_tool_allow', key }, (tools) => tools.includes(key));
    // Each saved answer is live: it answers a command of its own that would
    // otherwise card.
    for (const command of ['cat notes.md > copy.md', 'echo x > out.md']) {
      assert.deepStrictEqual((await ask(bash(command, 'jpw-saved-live'), { convo: 'jpw-saved-live' }).reply).body, ALWAYS, `the saved answer answers ${command}`);
    }
    // And so is the working folder: a file in home runs with no card.
    for (const [label, env] of MODES) {
      const out = await runHook('Bash', { command: 'cat ~/notes.txt' }, { convo: 'jpw-saved-live', env: { ...env, RUNDOCK_EXTRA_DIRS: extraDirs } });
      assert.strictEqual(out.permissionDecision, 'allow', `${label}: the working folder covers ~/notes.txt: ${JSON.stringify(out)}`);
    }
  });
  after(async () => {
    if (turn) turn.release();
    for (const key of KEYS) await throughWindow({ type: 'remove_tool_allow', key }, (tools) => !tools.includes(key));
    workingFolders.writeWorkingFolders(folders);
  });
  for (const [label, env] of MODES) {
    READS.forEach(([command, rel], i) => {
      test(`${label}: ${command} still asks as a secret`, async () => {
        await cardsAndTimesOut(command, rel, convoOf(label, i), { ...env, RUNDOCK_EXTRA_DIRS: extraDirs }, { secret: true });
      });
    });
  }
});

describe('with a window open, the card and what follows it', { skip: POSIX }, () => {
  const JOINED = 'cat ~/.claude/".credentials.json"';
  const credentials = () => file('.claude/.credentials.json');
  const isCard = (m) => m.type === 'control_request' && m.request;
  async function cardFor(client, command, convo, env, label) {
    const since = client.messages.length;
    const pending = runHook('Bash', { command }, { convo, env });
    const { msg } = await client.waitFor(isCard, { since, label });
    const crossing = (msg.request.crossings || []).find((c) => c && c.path === credentials());
    assert.ok(crossing && crossing.secret === true, `${label}: the card names the credential file as a secret`);
    return { msg, pending };
  }
  const refuse = (client, msg, convo) => client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: convo, allow: false });

  for (const [label, env] of MODES) {
    test(`${label}: after the card is refused, an ordinary read in the workspace runs with no card`, async () => {
      const client = await h.connect();
      const convo = `jpw-window-next-${label.split(' ')[0].toLowerCase()}`;
      try {
        const card = await cardFor(client, JOINED, convo, env, `${label}: the joined spelling`);
        refuse(client, card.msg, convo);
        assert.strictEqual((await card.pending).permissionDecision, 'deny');
        const since = client.messages.length;
        const out = await runHook('Bash', { command: 'cat notes.md' }, { convo, env });
        assert.strictEqual(out.permissionDecision, 'allow', JSON.stringify(out));
        await h.delay(200);
        assert.ok(!client.messages.slice(since).some(isCard), 'nothing was asked');
      } finally {
        client.close();
      }
    });

    test(`${label}: the same spelling again asks again, and the refusal kept nothing`, async () => {
      const client = await h.connect();
      const convo = `jpw-window-again-${label.split(' ')[0].toLowerCase()}`;
      try {
        const grants = boundary.readBoundaryGrants();
        const folders = workingFolders.readWorkingFolders();
        const allows = boundary.readToolAllows();
        const first = await cardFor(client, JOINED, convo, env, `${label}: first`);
        refuse(client, first.msg, convo);
        assert.strictEqual((await first.pending).permissionDecision, 'deny');
        const second = await cardFor(client, JOINED, convo, env, `${label}: again`);
        assert.deepStrictEqual(second.msg.request.crossings, first.msg.request.crossings, 'the same card');
        refuse(client, second.msg, convo);
        assert.strictEqual((await second.pending).permissionDecision, 'deny');
        assert.deepStrictEqual(boundary.readBoundaryGrants(), grants, 'no folder grant was stored');
        assert.deepStrictEqual(workingFolders.readWorkingFolders(), folders, 'no working folder was added');
        assert.deepStrictEqual(boundary.readToolAllows(), allows, 'no answer was saved');
      } finally {
        client.close();
      }
    });
  }
});
