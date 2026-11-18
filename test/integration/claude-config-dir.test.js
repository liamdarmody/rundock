'use strict';
// Integration: conversation history, its session path lookup, search's index
// and the Connectors tab's user-global source follow CLAUDE_CONFIG_DIR.
//
// With the variable set to an absolute path, Claude Code keeps its transcripts
// under `<folder>/projects` and its account state file at
// `<folder>/.claude.json`, and nothing in home (measured:
// scripts/runtime-home-truth/captured-runtime-homes.json). Every test here
// puts a file with the same name in the made-up home as well, so a read of
// home instead of the folder shows up as the wrong content rather than as a
// pass. The variable is set and removed in-process around each test; the
// restart is two real server processes, one with it and one without.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const h = require('../helpers/harness.js');
const { makeTempDir, makeWorkspace, standardTeam } = require('../helpers/workspace.js');
const hook = require('../../scripts/permission-hook.js');

const VARIABLE = 'CLAUDE_CONFIG_DIR';
const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server.js');
const RECORD = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'runtime-home-truth', 'captured-runtime-homes.json'), 'utf8'));
const POSIX_ONLY = process.platform === 'win32'
  ? 'Windows has no read-only folder mode: chmod sets only the read-only flag on files, so the folder could not refuse a write'
  : false;

let client;
// Whether the route's home is the made-up one. On Windows os.homedir() reads
// USERPROFILE, which the harness leaves alone, so no test reads the route with
// the variable unset there: it would read the account's own file.
let routeHomeIsMadeUp = false;

before(async () => {
  await h.boot();
  client = await h.connect();
  routeHomeIsMadeUp = os.homedir() === process.env.HOME;
});
after(async () => h.shutdown());

async function withVariable(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, VARIABLE);
  const old = process.env[VARIABLE];
  if (value === undefined) delete process.env[VARIABLE]; else process.env[VARIABLE] = value;
  try { return await fn(); } finally { if (had) process.env[VARIABLE] = old; else delete process.env[VARIABLE]; }
}
async function withThrowingHook(fn) {
  const real = hook.relocatedRuntimeHomes;
  hook.relocatedRuntimeHomes = () => { throw new Error('forced'); };
  try { return await fn(); } finally { hook.relocatedRuntimeHomes = real; }
}

const hash = () => h.internal.getWorkspace().replace(/\//g, '-');
const homeClaude = () => path.join(process.env.HOME, '.claude');
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const jsonl = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-07-01T10:00:00.000Z' }) + '\n';
// The moved folder and the made-up home, each with a transcript of this id in
// `folder`, saying which it is.
function seedBoth(sessionId, folder = hash()) {
  const moved = makeTempDir('config-dir-moved-');
  const real = path.join(moved, 'projects', folder, `${sessionId}.jsonl`);
  const decoy = path.join(homeClaude(), 'projects', folder, `${sessionId}.jsonl`);
  write(real, jsonl(`moved ${sessionId}`));
  write(decoy, jsonl(`home ${sessionId}`));
  return { moved, real, decoy };
}
function tidy() {
  fs.rmSync(homeClaude(), { recursive: true, force: true });
  fs.rmSync(path.join(process.env.HOME, '.claude.json'), { force: true });
  h.internal._sessionPathMemo.clear();
}

async function history(sessionId) {
  const conversationId = h.freshConvoId('history');
  const since = client.messages.length;
  client.send({ type: 'get_session_history', sessionId, conversationId, limit: 50 });
  const { msg } = await client.waitFor((m) => m.type === 'session_history' && m.conversationId === conversationId, { since, label: 'session_history' });
  return msg.messages.map((m) => m.content);
}
async function machine() {
  const res = await fetch(`http://127.0.0.1:${h.port}/api/connectors/machine`, { headers: h.authHeaders() });
  assert.strictEqual(res.status, 200);
  return res.json();
}

// Where the record saw Claude Code keep its account file: at the top of the
// variable's folder, and nothing in home.
function accountFileName() {
  const c = RECORD.runtimes.claude;
  assert.deepStrictEqual(c.created.home, [], 'the record saw nothing written in home');
  const name = Object.keys(c.files).find((n) => c.files[n].includes('relocated') && c.created.relocated.includes(n));
  assert.ok(name, 'the record names the account file it found in the variable\'s folder');
  return name;
}

// Every entry under root, with its size and modification time.
function listing(root) {
  if (!fs.existsSync(root)) return null;
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      out.push(`${path.relative(root, p)} ${st.isDirectory() ? 'dir' : st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}
function chmodTree(root, dirMode, fileMode) {
  const walk = (d) => {
    fs.chmodSync(d, dirMode);
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p); else fs.chmodSync(p, fileMode);
    }
  };
  walk(root);
}

describe('history and its session path lookup follow the variable', () => {
  test('the session path is found in the moved folder under the workspace\'s own name, never the same id in home', async () => {
    const { moved, real } = seedBoth('sess-direct');
    try {
      await withVariable(moved, () => assert.strictEqual(h.internal.getSessionJsonlPath('sess-direct'), real));
    } finally { tidy(); }
  });

  test('the fallback scan finds the moved file under another folder, never the same id in home', async () => {
    const { moved, real } = seedBoth('sess-fallback', 'some-other-project');
    try {
      await withVariable(moved, () => assert.strictEqual(h.internal.getSessionJsonlPath('sess-fallback'), real));
    } finally { tidy(); }
  });
});

describe('the Connectors tab reads the moved account file', () => {
  test('with the variable set, the user-global Claude source is the account file the record places in the folder', async () => {
    const moved = makeTempDir('config-dir-account-');
    write(path.join(moved, accountFileName()), '{"mcpServers":{"moved-server":{"command":"a"}}}');
    write(path.join(process.env.HOME, '.claude.json'), '{"mcpServers":{"home-server":{"command":"b"}}}');
    try {
      const body = await withVariable(moved, machine);
      assert.deepStrictEqual(body.claudeUserGlobal, { text: '{"mcpServers":{"moved-server":{"command":"a"}}}', missing: false, error: null });
      assert.ok(body.codexUserGlobal && 'missing' in body.codexUserGlobal, 'the Codex source is still answered');
    } finally { tidy(); }
  });
});

describe('read when called', () => {
  test('a value set after start, and then removed, is answered from where it is now', async () => {
    const { moved, real, decoy } = seedBoth('sess-when');
    write(path.join(moved, '.claude.json'), '{"moved":true}');
    write(path.join(process.env.HOME, '.claude.json'), '{"home":true}');
    try {
      await withVariable(moved, async () => {
        assert.strictEqual(h.internal.getSessionJsonlPath('sess-when'), real);
        assert.strictEqual((await machine()).claudeUserGlobal.text, '{"moved":true}');
      });
      await withVariable(undefined, async () => {
        assert.strictEqual(h.internal.getSessionJsonlPath('sess-when'), decoy);
        if (routeHomeIsMadeUp) assert.strictEqual((await machine()).claudeUserGlobal.text, '{"home":true}');
      });
    } finally { tidy(); }
  });
});

describe('the retry', () => {
  test('a session missed once is found in the moved folder once the negative memo expires', async () => {
    const moved = makeTempDir('config-dir-retry-');
    const real = path.join(moved, 'projects', hash(), 'sess-retry.jsonl');
    write(path.join(homeClaude(), 'projects', hash(), 'sess-retry.jsonl'), jsonl('home'));
    const internal = h.internal;
    internal._sessionPathMemo.clear();
    try {
      await withVariable(moved, () => {
        assert.strictEqual(internal.resolveSessionPathCached('sess-retry'), null, 'not in the moved folder yet');
        const memo = internal._sessionPathMemo.get('sess-retry');
        assert.ok(memo && memo.path === null, 'the miss is remembered');
        write(real, jsonl('moved'));
        assert.strictEqual(internal.resolveSessionPathCached('sess-retry'), null, 'within the window the miss holds');
        memo.ts = 0;
        assert.strictEqual(internal.resolveSessionPathCached('sess-retry'), real);
      });
    } finally { tidy(); }
  });
});

describe('the next step', () => {
  test('a conversation found in the moved folder opens, and is indexed for search from the same path', async () => {
    const { moved, real } = seedBoth('sess-next');
    write(real, jsonl('the quokka plan from the moved folder'));
    write(path.join(homeClaude(), 'projects', hash(), 'sess-next.jsonl'), jsonl('the wallaby decoy from home'));
    const file = path.join(h.workspaceDir, '.rundock', 'conversations.json');
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    const convos = original ? JSON.parse(original) : [];
    convos.push({ id: 'moved-c', agentId: 'chief-of-staff', sessionId: 'sess-next', sessionIds: [], title: 'Moved', status: 'active', createdAt: '2026-07-01T09:59:00.000Z', lastActiveAt: '2026-07-01T10:01:00.000Z' });
    write(file, JSON.stringify(convos, null, 2));
    try {
      await withVariable(moved, async () => {
        assert.deepStrictEqual(await history('sess-next'), ['the quokka plan from the moved folder']);
        const list = h.internal.conversationSessionsForSearch('moved-c');
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].sessions[0].filePath, real, 'indexed from the path it opened from');
        if (!require('../../search.js').probeSqlite().available) return; // no index on this runtime
        const engine = h.internal.ensureSearchEngine();
        assert.ok(engine, 'the index opened');
        h.internal.noteSearchConversationActivity('moved-c');
        assert.strictEqual(engine.searchMessages('quokka', { collapse: false }).length, 1);
        assert.strictEqual(engine.searchMessages('wallaby', { collapse: false }).length, 0);
      });
    } finally {
      if (original === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, original);
      tidy();
    }
  });
});

describe('the control failing', () => {
  test('when the shared function throws, history and the Connectors source find nothing, the server keeps answering, and home is never read', async () => {
    const { moved } = seedBoth('sess-throw');
    write(path.join(moved, '.claude.json'), '{"moved":true}');
    write(path.join(process.env.HOME, '.claude.json'), '{"home":true}');
    try {
      await withVariable(moved, () => withThrowingHook(async () => {
        assert.strictEqual(h.internal.getSessionJsonlPath('sess-throw'), null);
        assert.strictEqual(h.internal.resolveSessionPathCached('sess-throw'), null);
        assert.deepStrictEqual(await history('sess-throw'), []);
        const { claudeUserGlobal } = await machine();
        assert.strictEqual(claudeUserGlobal.text, null);
        assert.strictEqual(claudeUserGlobal.missing, false, 'said as unreadable, not as no connectors');
        assert.ok(typeof claudeUserGlobal.error === 'string' && claudeUserGlobal.error.length > 0);
      }));
      // Still answering once the function is back.
      await withVariable(moved, async () => {
        h.internal._sessionPathMemo.clear();
        assert.deepStrictEqual(await history('sess-throw'), ['moved sess-throw']);
      });
    } finally { tidy(); }
  });
});

describe('reads only', () => {
  test('a read-only moved folder is left exactly as it was by history, the session lookup and the Connectors route', { skip: POSIX_ONLY }, async () => {
    const { moved } = seedBoth('sess-readonly');
    write(path.join(moved, '.claude.json'), '{"moved":true}');
    chmodTree(moved, 0o555, 0o444);
    const homeBefore = listing(homeClaude());
    try {
      const before = listing(moved);
      await withVariable(moved, async () => {
        assert.deepStrictEqual(await history('sess-readonly'), ['moved sess-readonly']);
        assert.ok(h.internal.resolveSessionPathCached('sess-readonly'));
        assert.strictEqual(h.internal.getSessionJsonlPath('sess-absent'), null);
        assert.strictEqual((await machine()).claudeUserGlobal.text, '{"moved":true}');
      });
      assert.deepStrictEqual(listing(moved), before);
      assert.deepStrictEqual(listing(homeClaude()), homeBefore, 'nothing changed in home');
    } finally {
      chmodTree(moved, 0o755, 0o644);
      tidy();
    }
  });
});

// THE UNDO, AS A REAL RESTART: server.js started as its own process with the
// variable, then again without it, against one made-up home and workspace.
describe('the undo', () => {
  const BANNER_TIMEOUT_MS = 20000;
  const STUBS = [path.join(__dirname, '..', 'helpers', 'stub-claude'), path.join(__dirname, '..', 'helpers', 'stub-codex')];

  function bootChild(env) {
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no banner within ${BANNER_TIMEOUT_MS}ms:\n${out}`)), BANNER_TIMEOUT_MS);
      child.stdout.on('data', (chunk) => {
        out += chunk.toString();
        const m = /Rundock is running: (http:\/\/localhost:(\d+)\/#c=[A-Za-z0-9_-]+)/.exec(out);
        if (m) { clearTimeout(timer); resolve({ port: Number(m[2]), link: m[1] }); }
      });
      child.stderr.on('data', (chunk) => { out += chunk.toString(); });
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code} before its banner:\n${out}`)); });
    });
    return { child, ready };
  }
  function stopChild(child) {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  }
  // What one server answers: the transcript it opens, and the account file
  // the Connectors route reads.
  async function ask({ port, link }) {
    const WebSocket = require('ws');
    const headers = await require('../../scripts/sign-in-link.js').exchangeForSession(link);
    const res = await fetch(`http://127.0.0.1:${port}/api/connectors/machine`, { headers });
    const account = (await res.json()).claudeUserGlobal.text;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    try {
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no session_history')), 20000);
        ws.on('message', (data) => {
          let m = null;
          try { m = JSON.parse(data.toString()); } catch (e) { return; }
          if (m.type === 'session_history' && m.conversationId === 'undo-c') { clearTimeout(timer); resolve(m); }
        });
        ws.on('open', () => ws.send(JSON.stringify({ type: 'get_session_history', sessionId: 'sess-undo', conversationId: 'undo-c', limit: 50 })));
        ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      return { history: reply.messages.map((m) => m.content), account };
    } finally { ws.close(); }
  }

  test('with the variable removed and the server restarted, reads return to home', async () => {
    const home = makeTempDir('config-dir-undo-home-');
    const moved = makeTempDir('config-dir-undo-moved-');
    const workspace = makeWorkspace({ agents: standardTeam(), claudeMd: '# Undo\n' });
    // Under a folder no workspace is named for, so the scan finds it whatever
    // name the server gives the workspace.
    write(path.join(moved, 'projects', 'any-project', 'sess-undo.jsonl'), jsonl('from the moved folder'));
    write(path.join(home, '.claude', 'projects', 'any-project', 'sess-undo.jsonl'), jsonl('from home'));
    write(path.join(moved, '.claude.json'), '{"moved":true}');
    write(path.join(home, '.claude.json'), '{"home":true}');
    const env = {
      ...process.env,
      PATH: STUBS.join(path.delimiter) + path.delimiter + process.env.PATH,
      PORT: '0', HOME: home, USERPROFILE: home, RUNDOCK_ELECTRON: '1', WORKSPACE: workspace,
    };
    const answers = [];
    for (const variable of [moved, undefined]) {
      const childEnv = { ...env };
      if (variable === undefined) delete childEnv[VARIABLE]; else childEnv[VARIABLE] = variable;
      const { child, ready } = bootChild(childEnv);
      try { answers.push(await ask(await ready)); } finally { await stopChild(child); }
    }
    assert.deepStrictEqual(answers, [
      { history: ['from the moved folder'], account: '{"moved":true}' },
      { history: ['from home'], account: '{"home":true}' },
    ]);
  });
});
