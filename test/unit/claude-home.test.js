'use strict';
// WHERE RUNDOCK READS CLAUDE CODE'S OWN FILES FROM, with and without
// CLAUDE_CONFIG_DIR.
//
// Claude Code keeps its transcripts, its user settings and its account state
// file in `~/.claude` and `~/.claude.json`, or, with CLAUDE_CONFIG_DIR set to
// an absolute path, all of them in that folder and nothing in home. Rundock
// reads all three: the transcript reader the scheduler uses, conversation
// history, the Connectors tab and the Permissions row's sandbox status. Each
// asks lib/runtime/claude-home.js, which asks the permission hook's
// relocatedRuntimeHomes, the one place the variable is read.
//
// This file holds the module to that, the four readers to asking it (by an
// inventory of their source), and the two readers that need no server (the
// transcript reader and the sandbox status) to what they find. History and the
// Connectors route are held in test/integration/claude-config-dir.test.js.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hook = require('../../scripts/permission-hook.js');
const { claudeHome } = require('../../lib/runtime/claude-home.js');
const { findTranscript, readSessionTranscript } = require('../../lib/runtime/session-transcript.js');
const { sandboxStatus } = require('../../lib/workspace/sandbox-status.js');

const ROOT = path.join(__dirname, '..', '..');
const VARIABLE = 'CLAUDE_CONFIG_DIR';
const RECORD = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'runtime-home-truth', 'captured-runtime-homes.json'), 'utf8'));
const READERS = ['server.js', 'lib/runtime/session-transcript.js', 'lib/http-router.js', 'lib/workspace/sandbox-status.js'];
const POSIX_ONLY = process.platform === 'win32'
  ? 'Windows has no read-only folder mode: chmod sets only the read-only flag on files, so the folder could not refuse a write'
  : false;

const made = [];
const saved = {};
let home;

function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

before(() => {
  for (const k of ['HOME', 'USERPROFILE', VARIABLE]) saved[k] = process.env[k];
  home = tempDir('claude-home-home-');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env[VARIABLE];
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of made) { writable(d); fs.rmSync(d, { recursive: true, force: true }); }
});

// Sets the variable (undefined removes it) for the length of fn, and puts it
// back whatever fn does.
function withVariable(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, VARIABLE);
  const old = process.env[VARIABLE];
  if (value === undefined) delete process.env[VARIABLE]; else process.env[VARIABLE] = value;
  try { return fn(); } finally { if (had) process.env[VARIABLE] = old; else delete process.env[VARIABLE]; }
}
// The shared function throwing, replaced on the hook's module object and
// put back.
function withThrowingHook(fn) {
  const real = hook.relocatedRuntimeHomes;
  hook.relocatedRuntimeHomes = () => { throw new Error('forced'); };
  try { return fn(); } finally { hook.relocatedRuntimeHomes = real; }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const line = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-07-01T10:00:00.000Z' }) + '\n';

// Every entry under root, with its size and modification time.
function listing(root) {
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
  if (!fs.existsSync(root)) return;
  const walk = (d) => {
    fs.chmodSync(d, dirMode);
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p); else fs.chmodSync(p, fileMode);
    }
  };
  walk(root);
}
const readOnly = (root) => chmodTree(root, 0o555, 0o444);
function writable(root) { if (process.platform !== 'win32') chmodTree(root, 0o755, 0o644); }

describe('where Claude Code keeps its files', () => {
  test('with the variable unset, the folder and the account file are in home', () => {
    withVariable(undefined, () => {
      assert.deepStrictEqual(claudeHome(home), {
        folder: path.join(home, '.claude'), accountState: path.join(home, '.claude.json'), relocated: false,
      });
    });
  });

  test('with the variable set, everything is inside its folder, the account file included, as the record measured', () => {
    // The record: Claude Code kept the account file at the top of the
    // variable's folder, not beside it, and wrote nothing in home.
    const c = RECORD.runtimes.claude;
    assert.strictEqual(c.variable, VARIABLE);
    assert.deepStrictEqual(c.created.home, []);
    const accountName = Object.keys(c.files).find((name) => c.files[name].includes('relocated') && c.created.relocated.includes(name));
    assert.ok(accountName, 'the record names the account file it found in the variable\'s folder');
    const moved = tempDir('claude-home-moved-');
    withVariable(moved, () => {
      assert.deepStrictEqual(claudeHome(home), { folder: moved, accountState: path.join(moved, accountName), relocated: true });
    });
  });

  test('a relative or empty value names no folder, and reads home the same as unset', () => {
    for (const value of [path.join('relative', 'folder'), '']) {
      withVariable(value, () => {
        assert.deepStrictEqual(claudeHome(home), {
          folder: path.join(home, '.claude'), accountState: path.join(home, '.claude.json'), relocated: false,
        }, JSON.stringify(value));
      });
    }
  });

  test('the folder is read at each call, not when the module loads', () => {
    const first = tempDir('claude-home-first-');
    const second = tempDir('claude-home-second-');
    withVariable(first, () => assert.strictEqual(claudeHome(home).folder, first));
    withVariable(second, () => assert.strictEqual(claudeHome(home).folder, second));
    withVariable(undefined, () => assert.strictEqual(claudeHome(home).folder, path.join(home, '.claude')));
  });

  test('a throw from the shared function reaches the caller, never read as unset', () => {
    withThrowingHook(() => assert.throws(() => claudeHome(home), /forced/));
  });
});

// AN INVENTORY OF THE FOUR READERS' SOURCE. Each `.claude` path literal in
// code (comments are dropped) is placed by what it is joined onto: a
// workspace folder is allowed, anything else is a join onto home and fails.
// A literal joined onto nothing (a label, a prefix test) is allowed.
const WORKSPACE_BASES = new Set(['WORKSPACE', 'dir', 'fullPath']);
const CLAUDE_LITERAL = /(['"`])(?:(?!\1)[^\\\n]|\\.)*\.claude(?:(?!\1)[^\\\n]|\\.)*\1/;
const HOME_WORD = /\bhome\b|homedir\s*\(|\bHOME\b|USERPROFILE/;

// Drops comment lines, block comments and trailing comments, keeping strings.
function codeOnly(source) {
  const out = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    let quote = null;
    let cut = raw.length;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '\\') { i++; continue; }
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '/' && raw[i + 1] === '/') { cut = i; break; }
    }
    out.push(raw.slice(0, cut));
  }
  return out.join('\n');
}

// The arguments of the call whose opening parenthesis is at `open`.
function callArgs(code, open) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      depth--;
      if (depth === 0) { args.push(code.slice(start, i).trim()); return args; }
    } else if (ch === ',' && depth === 1) { args.push(code.slice(start, i).trim()); start = i + 1; }
  }
  return args;
}

function homeJoins(source) {
  const code = codeOnly(source);
  const found = [];
  const onto = (base, text) => { if (!WORKSPACE_BASES.has(base.trim())) found.push(text.replace(/\s+/g, ' ').trim()); };
  for (const m of code.matchAll(/\bpath(?:\.(?:posix|win32))?\.(?:join|resolve)\s*\(/g)) {
    const args = callArgs(code, m.index + m[0].length - 1);
    if (args.slice(1).some((a) => CLAUDE_LITERAL.test(a))) onto(args[0], `${m[0]}${args.join(', ')})`);
  }
  for (const m of code.matchAll(/([\w$.]+(?:\([^()]*\))?)\s*\+\s*(['"`])[/\\]*\.claude/g)) onto(m[1], m[0]);
  for (const m of code.matchAll(/\$\{([^}]+)\}[/\\]+\.claude/g)) onto(m[1], m[0]);
  for (const l of code.split('\n')) {
    if (CLAUDE_LITERAL.test(l) && HOME_WORD.test(l) && !found.some((f) => l.replace(/\s+/g, ' ').includes(f))) found.push(l.trim());
  }
  return found;
}

describe('one decision: no reader joins Claude Code\'s folder onto home', () => {
  test('the inventory flags every way of joining onto home, and allows workspace joins, comments and labels', () => {
    const flagged = [
      "path.join(home, '.claude', 'projects')",
      "path.join(os.homedir(), '.claude.json')",
      "path.join(home, '.claude/projects')",
      "path.resolve(process.env.HOME, '.claude')",
      "path.join(base, '.claude')",
      "path.join(\n  home,\n  '.claude',\n)",
      'const f = `${home}/.claude/settings.json`;',
      "const f = home + '/.claude';",
      "const f = os.homedir() + '/.claude.json';",
      "const f = [home, '.claude'].join('/');",
    ];
    for (const sample of flagged) assert.notDeepStrictEqual(homeJoins(sample), [], sample);
    const allowed = [
      "path.join(WORKSPACE, '.claude', 'agents')",
      "path.join(dir, '.claude', 'settings.json')",
      "fs.existsSync(path.join(fullPath, '.claude'))",
      '// reads ~/.claude/projects under home',
      "/* path.join(home, '.claude') */",
      "const x = 1; // path.join(home, '.claude')",
      "e.target.startsWith('.claude/agents/')",
      "layers.push({ label: '~/.claude/settings.json', file });",
      "path.join(claude.folder, 'projects')",
      "const hash = WORKSPACE.replace(/\\//g, '-'); path.join(WORKSPACE, '.claude')",
    ];
    for (const sample of allowed) assert.deepStrictEqual(homeJoins(sample), [], sample);
  });

  test('none of the four readers joins .claude or .claude.json onto a home folder, and each asks the shared function', () => {
    for (const file of READERS) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.deepStrictEqual(homeJoins(source), [], `${file} joins Claude Code's folder onto home`);
      assert.ok(source.includes('claudeHome('), `${file} asks lib/runtime/claude-home.js`);
    }
  });
});

describe('the transcript reader follows the variable', () => {
  const SID = 'a0000000-0000-4000-8000-0000000moved';

  test('with the variable set, the moved transcript is found and the one in home with the same id is not', () => {
    const decoy = path.join(home, '.claude', 'projects', 'some-project', `${SID}.jsonl`);
    const moved = tempDir('claude-home-transcript-');
    // Where the record saw Claude Code put a transcript under the variable.
    assert.ok(RECORD.runtimes.claude.created.relocated.includes('projects/<case>/<id>.jsonl'));
    const real = path.join(moved, 'projects', 'another-project', `${SID}.jsonl`);
    write(decoy, line('in home'));
    write(real, line('in the moved folder'));
    try {
      withVariable(moved, () => {
        assert.strictEqual(findTranscript(SID), real);
        assert.strictEqual(readSessionTranscript(SID).status, 'known');
      });
      withVariable(undefined, () => assert.strictEqual(findTranscript(SID), decoy, 'unset reads home, as before'));
    } finally {
      fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    }
  });

  test('with no home at all, the variable still names where the transcript is', () => {
    const moved = tempDir('claude-home-nohome-');
    const real = path.join(moved, 'projects', 'p', `${SID}.jsonl`);
    write(real, line('no home'));
    const h = process.env.HOME;
    const p = process.env.USERPROFILE;
    try {
      delete process.env.HOME;
      delete process.env.USERPROFILE;
      withVariable(moved, () => assert.strictEqual(findTranscript(SID), real));
    } finally {
      process.env.HOME = h;
      process.env.USERPROFILE = p;
    }
  });

  test('when the shared function throws, nothing is found, nothing throws, and home is never read instead', () => {
    const decoy = path.join(home, '.claude', 'projects', 'some-project', `${SID}.jsonl`);
    write(decoy, line('in home'));
    try {
      withThrowingHook(() => {
        assert.strictEqual(findTranscript(SID), null);
        assert.strictEqual(readSessionTranscript(SID).reason, 'no-transcript');
      });
    } finally {
      fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    }
  });

  test('a fresh load after the variable is removed reads home again', () => {
    const moved = tempDir('claude-home-reload-');
    const real = path.join(moved, 'projects', 'p', `${SID}.jsonl`);
    const decoy = path.join(home, '.claude', 'projects', 'p', `${SID}.jsonl`);
    write(real, line('moved'));
    write(decoy, line('home'));
    const fresh = () => {
      for (const m of ['lib/runtime/claude-home.js', 'lib/runtime/session-transcript.js']) delete require.cache[require.resolve(path.join(ROOT, m))];
      return require(path.join(ROOT, 'lib', 'runtime', 'session-transcript.js'));
    };
    try {
      withVariable(moved, () => assert.strictEqual(fresh().findTranscript(SID), real));
      withVariable(undefined, () => assert.strictEqual(fresh().findTranscript(SID), decoy));
    } finally {
      fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    }
  });

  test('reads only: a read-only moved folder is left exactly as it was', { skip: POSIX_ONLY }, () => {
    const moved = tempDir('claude-home-readonly-');
    write(path.join(moved, 'projects', 'p', `${SID}.jsonl`), line('read only'));
    readOnly(moved);
    try {
      const before = listing(moved);
      withVariable(moved, () => {
        assert.ok(findTranscript(SID));
        assert.strictEqual(readSessionTranscript(SID).status, 'known');
        assert.strictEqual(findTranscript('a0000000-0000-4000-8000-000000absent'), null);
      });
      assert.deepStrictEqual(listing(moved), before);
      assert.ok(!fs.existsSync(path.join(home, '.claude')), 'nothing was made in home');
    } finally {
      writable(moved);
    }
  });
});

describe('the sandbox status reads the moved user settings', () => {
  // A workspace, a made-up home for the status to be handed, and no managed
  // settings file.
  function fixture() {
    const dir = tempDir('claude-home-ws-');
    const userHome = tempDir('claude-home-userhome-');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    return { dir, userHome, opts: { home: userHome, managedPath: path.join(userHome, 'no-managed-settings.json') } };
  }
  const ON = JSON.stringify({ sandbox: { enabled: true } });

  test('with the variable set, the user settings file is read from its folder and named by its real path', () => {
    const f = fixture();
    const moved = tempDir('claude-home-settings-');
    write(path.join(moved, 'settings.json'), ON);
    withVariable(moved, () => {
      const s = sandboxStatus(f.dir, 'darwin', f.opts);
      assert.strictEqual(s.on, true);
      assert.strictEqual(s.setBy, 'elsewhere');
      assert.deepStrictEqual(s.enabledElsewhere, [path.join(moved, 'settings.json')]);
    });
    // And a home file turning it on is not the moved folder's.
    const g = fixture();
    write(path.join(g.userHome, '.claude', 'settings.json'), ON);
    withVariable(tempDir('claude-home-empty-'), () => {
      const s = sandboxStatus(g.dir, 'darwin', g.opts);
      assert.strictEqual(s.on, false);
      assert.deepStrictEqual(s.enabledElsewhere, []);
    });
  });

  test('with the variable unset, the home file keeps its label', () => {
    const f = fixture();
    write(path.join(f.userHome, '.claude', 'settings.json'), ON);
    withVariable(undefined, () => {
      assert.deepStrictEqual(sandboxStatus(f.dir, 'darwin', f.opts).enabledElsewhere, ['~/.claude/settings.json']);
    });
  });

  test('when the shared function throws, the user layer is not read, from home or anywhere', () => {
    const f = fixture();
    write(path.join(f.userHome, '.claude', 'settings.json'), ON);
    write(path.join(f.dir, '.claude', 'settings.json'), ON);
    withThrowingHook(() => {
      assert.deepStrictEqual(sandboxStatus(f.dir, 'darwin', f.opts).enabledElsewhere, ['.claude/settings.json']);
    });
  });

  test('reads only: a read-only moved folder is left exactly as it was', { skip: POSIX_ONLY }, () => {
    const f = fixture();
    const moved = tempDir('claude-home-settings-ro-');
    write(path.join(moved, 'settings.json'), ON);
    readOnly(moved);
    try {
      const before = listing(moved);
      withVariable(moved, () => assert.strictEqual(sandboxStatus(f.dir, 'darwin', f.opts).on, true));
      assert.deepStrictEqual(listing(moved), before);
      assert.ok(!fs.existsSync(path.join(f.userHome, '.claude')), 'nothing was made in home');
    } finally {
      writable(moved);
    }
  });
});
