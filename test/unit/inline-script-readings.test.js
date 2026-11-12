'use strict';
// Spellings in an inline script that read as writes outside the workspace, and
// the writes outside that still ask beside them.
//
// Agents run small scripts inline (`python3 - <<'EOF' ... EOF`, `python3 -c`),
// and the shell check reads the script's string literals and words for places.
// A harmless spelling read as a write outside has nothing to grant: a card in
// Code mode, and a refusal when nobody is there to answer it.
//
// The pieces start with `/etc`, a first folder every POSIX host has, so each
// line reads the same on macOS and Linux: an absolute literal whose first
// folder is missing is text there already. Every reading that stops carding
// sits beside the cards it must keep.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hook = require('../../scripts/permission-hook.js');
const fx = require('../helpers/code-mode-fixture.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
// By its real path, so a path spelled under it is already in canonical form.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inline-script-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, 'home');
const ws = path.join(home, 'Workspace');
fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
fs.writeFileSync(path.join(ws, 'notes', 'a.md'), 'one\n\ntwo\n');

const POSIX = { skip: process.platform === 'win32' && 'bash on a macOS or Linux host' };
const MODES = [['Notes', false], ['Code', true]];
const WIN_WS = 'C:\\Users\\someone\\ws';
const scan = (command, { tool = 'Bash', codeMode = false, workspace = ws, opts = {} } = {}) =>
  hook.classifyShellAccess(tool, { command }, workspace, [], home, false, { codeMode, ...opts });
const places = (command, o) => {
  const r = scan(command, o);
  return r ? r.crossings.map(c => c.path) : [];
};
const real = p => hook.canonicalize(p);
const etc = real('/etc/x');
const py = (...lines) => `python3 - <<'EOF'\n${lines.join('\n')}\nEOF`;
// A write outside to `want`, with nothing that would let it pass.
const asksAsWrite = (command, want, o) => {
  const r = scan(command, o);
  assert.ok(r && r.where === 'outside' && r.grantable === false, `${command}: ${JSON.stringify(r)}`);
  const hit = r.crossings.find(c => c.path === want && c.write === true);
  assert.ok(hit, `${command}: a write to ${want} in ${JSON.stringify(r.crossings)}`);
  return hit;
};

// The three lines, each a write outside on main.
const lines = (w) => ({
  joined: py('import sys', `V = "${w}"`, 'sys.path.insert(0, V + "/etc/tools/lib")', 'print(open(V + "/notes/a.md").read())'),
  backslashes: py('t = open("notes/a.md").read()', "parts = t.split('\\\\n\\\\n')", 'print(len(parts))'),
  percent: py('t = open("notes/a.md").read()', 'a, b = 0, len(t)', 'print("%d" % (100*(b-a)/len(t)))'),
});
const MAIN_RED = lines(ws);
// The same intent, written the ways that already raised nothing.
const ALREADY_RAN = [
  py('import sys', `V = "${ws}"`, 'sys.path.insert(0, f"{V}/etc/tools/lib")'),
  `python3 -c "t = open('notes/a.md').read(); print(len(t.split('\\\\n\\\\n')))"`,
  py('t = open("notes/a.md").read()', 'a, b = 0, len(t)', 'print(100*(b-a)/len(t))'),
];
// The lines that must still ask, each a write outside.
const STILL_ASKS = (h, w) => ({
  hiddenHome: py(`H = "${h}"`, 'open(H + "/.ssh/config", "a").write("x")'),
  launchAgent: py(`H = "${h}"`, 'open(H + "/Library/LaunchAgents/x.plist", "w").write("x")'),
  assignedTwice: py(`V = "${w}"`, 'V = "/"', 'open(V + "/etc/x", "w").write("x")'),
  fromArgv: `python3 - "${w}" <<'EOF'\nimport sys\nV = sys.argv[1]\nopen(V + "/etc/x", "w").write("x")\nEOF`,
  fromEnviron: py('import os', 'V = os.environ["X"]', 'open(V + "/etc/x", "w").write("x")'),
  fromInput: py('V = input()', 'open(V + "/etc/x", "w").write("x")'),
  inFunction: py('def save():', `    V = "${w}"`, '    open(V + "/etc/x", "w").write("x")', 'save()'),
  plusEquals: py(`V = "${w}"`, 'V += "/../.."', 'open(V + "/etc/x", "w").write("x")'),
  climbsOut: py(`V = "${w}"`, 'open(V + "/../../etc/x", "w").write("x")'),
});
const ASKS = STILL_ASKS(home, ws);

// ===== A PIECE JOINED ONTO A NAME GIVEN ONE PLAIN STRING, ONCE =====

describe('a piece joined onto a name given the workspace once is judged as the whole path', POSIX, () => {
  const CALLS = [
    'sys.path.insert(0, V + "/etc/tools/lib")',
    'print(V + "/etc/x/y")',
    'open(V + "/etc/x/y", "w").write("x")',
    'os.makedirs(V + "/etc/x/y")',
    'shutil.rmtree(V + "/etc/x/y")',
  ];
  for (const [mode, codeMode] of MODES) {
    test(`in a here-document, in any call, a write among them (${mode} mode)`, () => {
      assert.deepStrictEqual(places(MAIN_RED.joined, { codeMode }), []);
      for (const call of CALLS) {
        assert.deepStrictEqual(places(py('import os, shutil, sys', `V = "${ws}"`, call), { codeMode }), [], call);
      }
    });

    test(`in python3 -c, first on its line or after other statements (${mode} mode)`, () => {
      for (const call of CALLS.map(c => c.replace(/"/g, "'"))) {
        for (const c of [`python3 -c "V = '${ws}'; ${call}"`, `python3 -c "import os, shutil, sys; V = '${ws}'; ${call}"`]) {
          assert.deepStrictEqual(places(c, { codeMode }), [], c);
        }
      }
    });
  }

  test('the joined path is what is judged: written, it is a write inside the workspace', () => {
    const permissions = path.join(ws, '.rundock', 'permissions.json');
    const w = scan(py(`V = "${ws}"`, 'open(V + "/.rundock/permissions.json", "w").write("{}")'));
    assert.ok(w && w.crossings.some(c => c.answerFile === true && c.path === permissions), `the answer-file card: ${JSON.stringify(w)}`);
    assert.strictEqual(scan(py(`V = "${ws}"`, 'print(open(V + "/.rundock/permissions.json").read())')), null, 'read, it is a read');
    assert.deepStrictEqual(places(py(`V = "${ws}"`, 'open(V + "/notes/b.md", "w").write("x")')), [], 'and an ordinary file is ordinary');
  });

  // os.path.join and pathlib's `/` were judged whole before this change, and
  // a relative piece in either was never a place by itself.
  test('os.path.join and pathlib are read as they were', () => {
    for (const call of ['open(os.path.join(V, "etc/x"), "w")', 'open(pathlib.Path(V) / "etc/x", "w")']) {
      assert.deepStrictEqual(places(py('import os, pathlib', `V = "${ws}"`, call)), [], call);
    }
  });
});

describe('each of these still asks, as before', POSIX, () => {
  test('home with a hidden folder joined on', () => {
    const hit = asksAsWrite(ASKS.hiddenHome, path.join(home, '.ssh', 'config'));
    assert.strictEqual(hit.hiddenHome, '.ssh');
  });

  test('home with a launch agent joined on', () => {
    asksAsWrite(ASKS.launchAgent, path.join(home, 'Library', 'LaunchAgents', 'x.plist'));
  });

  test('a name assigned twice, however the second is written', () => {
    for (const c of [
      ASKS.assignedTwice,
      py(`V = "${ws}"`, 'if True: V = "/"', 'open(V + "/etc/x", "w").write("x")'),
      py(`V = "${ws}"`, 'W = V = "/"', 'open(V + "/etc/x", "w").write("x")'),
    ]) {
      asksAsWrite(c, etc);
    }
  });

  test('a name from sys.argv, the environment or input()', () => {
    for (const c of [ASKS.fromArgv, ASKS.fromEnviron, ASKS.fromInput]) asksAsWrite(c, etc);
  });

  test('a name given its value inside a function or a loop, or rebound with +=', () => {
    for (const c of [
      ASKS.inFunction,
      py('for _ in range(1):', `    V = "${ws}"`, '    open(V + "/etc/x", "w").write("x")'),
      ASKS.plusEquals,
    ]) {
      asksAsWrite(c, etc);
    }
  });

  test('a joined path that climbs out', () => {
    asksAsWrite(ASKS.climbsOut, real(path.resolve(ws, '../../etc/x')));
  });
});

// One test per way past what the reading trusts: the script text as written,
// where a piece is dropped only when what it is joined onto is seen in that
// text and the whole path is judged instead.
describe('every way past a joined piece keeps its card', POSIX, () => {
  test('route: a dangerous piece joined onto a harmless-looking name is judged in full', () => {
    asksAsWrite(ASKS.hiddenHome, path.join(home, '.ssh', 'config'));
    const secret = scan(py(`H = "${home}"`, 'print(open(H + "/.claude/.credentials.json").read())'));
    assert.ok(secret && secret.crossings.some(c => c.secret === true), `a credential file, read: ${JSON.stringify(secret)}`);
  });

  test('route: the piece is dropped only where the whole path it joins is judged', () => {
    for (const c of [
      // A whole path that is not shaped like a place is not judged, so the
      // piece is: `//etc/x` is `/etc/x` to the system.
      py('V = "/"', 'open(V + "/etc/x", "w").write("x")'),
      py('open("/" + "/etc/x", "w").write("x")'),
      // A whole path with a part the code works out as it runs.
      py('import os', 'open(os.getcwd() + "/etc/x", "w").write("x")'),
      py(`V = "${ws}"`, 'open(V + os.sep + "/etc/x", "w").write("x")'),
      py(`V = "${ws}"`, 'open((V + "/etc/x"), "w").write("x")'),
    ]) {
      asksAsWrite(c, etc);
    }
  });

  test('route: a name assigned more than once keeps today\'s reading', () => {
    asksAsWrite(ASKS.assignedTwice, etc);
    asksAsWrite(py(`V = "${ws}"`, 'open(V + "/etc/x", "w").write("x")', 'V = "/"'), etc, 'a second value after the use counts too');
    // Even when every value it is given is inside: the name is not known.
    asksAsWrite(py(`V = "${ws}"`, `V = "${ws}"`, 'open(V + "/etc/x", "w").write("x")'), etc, 'given the workspace twice');
    asksAsWrite(py(`V = "${ws}"`, `V = "${path.join(ws, 'notes')}"`, 'open(V + "/etc/x", "w").write("x")'), etc, 'given two folders inside');
  });

  test('route: a name taken from outside the script keeps today\'s reading', () => {
    for (const c of [ASKS.fromArgv, ASKS.fromEnviron, ASKS.fromInput, py('V = open("notes/a.md").read().strip()', 'open(V + "/etc/x", "w").write("x")')]) {
      asksAsWrite(c, etc);
    }
  });

  test('route: a name rebound any other way keeps today\'s reading', () => {
    const use = 'open(V + "/etc/x", "w").write("x")';
    for (const c of [
      py(`V = "${ws}"`, 'def f():', '    global V', '    V = "/"', 'f()', use),
      py(`V = "${ws}"`, 'for V in ["/"]:', '    pass', use),
      py(`V = "${ws}"`, 'del V', use),
      ASKS.plusEquals,
      py(`V = "${ws}"`, 'if (V := "/"):', `    ${use}`),
      py(`V = "${ws}"`, 'def f(V):', `    ${use}`, 'f("/")'),
      py(`V = "${ws}"`, 'from os import sep as V', use),
      py(`V = "${ws}"`, `[open(V + "/etc/x", "w") for V in ["/"]]`),
      py(`V = "${ws}"`, 'print(f"{(V := chr(47))}")', use),
      py(`V = "${ws}"`, 'exec("V = chr(47)")', use),
      py(`V = "${ws}"`, 'globals()["V"] = "/"', use),
      py(`V = "\\x2f"`, use),
      `node - <<'JS'\nvar V = "${ws}";\nif (process.argv.length) { V = process.argv[1]; }\nrequire('fs').writeFileSync(V + "/etc/x", "x");\nJS`,
    ]) {
      asksAsWrite(c, etc);
    }
  });
});

// The reading of a joined piece fails through a seam on the hook module, never
// through anything a caller sets: the line is judged as it was before that
// reading existed.
describe('when the reading of a joined piece fails, the line gets today\'s answer', POSIX, () => {
  const forced = (fn) => {
    const seam = hook.joinedPieceSeam;
    const was = seam.beforeReading;
    seam.beforeReading = () => { throw new Error('forced failure'); };
    try { return fn(); } finally { seam.beforeReading = was; }
  };
  const JOINED_ETC = py(`V = "${ws}"`, 'open(V + "/etc/x", "w").write("x")');

  test('the control failing, in process: the piece is judged on its own, a write outside', () => {
    assert.strictEqual(scan(JOINED_ETC), null, 'sanity: with nothing forced it is the joined path');
    forced(() => {
      asksAsWrite(JOINED_ETC, etc);
      asksAsWrite(MAIN_RED.joined.replace('/etc/tools/lib', '/etc/x'), etc);
    });
  });

  // The real hook, as its own process, with the failure forced by a file
  // loaded ahead of it on the command line it is started with, as in
  // hook-never-crashes.test.js. The hook's own module is reached as it is
  // compiled, since it runs as the main module there.
  const failing = path.join(root, 'joined-piece-reading-fails.js');
  fs.writeFileSync(failing, [
    "const Module = require('module');",
    'const compile = Module.prototype._compile;',
    'Module.prototype._compile = function (content, filename) {',
    '  const out = compile.call(this, content, filename);',
    `  if (filename.endsWith(${JSON.stringify(path.join('scripts', 'permission-hook.js'))})) this.exports.joinedPieceSeam.beforeReading = () => { throw new Error('forced failure'); };`,
    '  return out;',
    '};',
    '',
  ].join('\n'));
  const run = (command, preload) => {
    const r = spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), HOOK], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: 's', tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, NODE_V8_COVERAGE: '', RUNDOCK: '1', RUNDOCK_PORT: '1', RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: '', RUNDOCK_CODE_MODE: '1', HOME: home, USERPROFILE: home },
    });
    let answer = null;
    try { answer = JSON.parse(r.stdout).hookSpecificOutput; } catch (e) { /* asserted below */ }
    return { status: r.status, stderr: r.stderr, decision: answer && answer.permissionDecision, reason: answer && answer.permissionDecisionReason };
  };

  test('the control failing, through the real hook in Code mode: it answers, as the line that keeps today\'s reading is answered', () => {
    const plain = run(JOINED_ETC);
    assert.strictEqual(plain.status, 0, plain.stderr);
    assert.strictEqual(plain.decision, 'allow', 'sanity: with nothing forced it runs');
    const r = run(JOINED_ETC, failing);
    assert.strictEqual(r.status, 0, `the hook never crashes: ${r.stderr}`);
    assert.strictEqual(r.decision, 'deny', 'with nobody to ask, the write outside is refused');
    const today = run(ASKS.assignedTwice);
    assert.strictEqual(r.decision, today.decision);
    assert.strictEqual(r.reason, today.reason, 'in the same words');
  });
});

describe('the inverse action', POSIX, () => {
  test('a join onto the workspace runs, and one onto home in the next command asks', () => {
    assert.strictEqual(scan(py(`V = "${ws}"`, 'open(V + "/etc/x", "w").write("x")'), { codeMode: true }), null);
    asksAsWrite(ASKS.hiddenHome, path.join(home, '.ssh', 'config'), { codeMode: true });
  });
});

// ===== A DOUBLED BACKSLASH =====

describe('a doubled backslash in Bash on macOS and Linux is not a network path', () => {
  for (const [mode, codeMode] of MODES) {
    test(`in a here-document, and in a -c argument quoted either way (${mode} mode)`, POSIX, () => {
      for (const c of [
        MAIN_RED.backslashes,
        `python3 -c "print(open('notes/a.md').read().split('\\\\n\\\\n'))"`,
        `python3 -c 'print(open("notes/a.md").read().split("\\\\n\\\\n"))'`,
        "cp notes/a.md '\\\\server\\share\\a.md'",
      ]) {
        assert.deepStrictEqual(places(c, { codeMode }), [], c);
      }
    });
  }

  test('read as a POSIX path, a climb written after one still cards', POSIX, () => {
    assert.deepStrictEqual(places("cat '\\\\x/../../../outside.txt'"), [real(path.join(root, 'outside.txt'))]);
    asksAsWrite(py("open('\\\\\\\\x/../../../outside.txt', 'w').write('x')"), real(path.join(root, 'outside.txt')));
  });

  test('route: on a Windows host a network path in Bash still crosses, quoted or not', () => {
    for (const workspace of [WIN_WS, ws]) {
      for (const c of ["cp a.md '\\\\server\\share\\x'", 'cp a.md \\\\server\\share\\x', 'echo hi > "\\\\server\\share\\x"']) {
        const r = scan(c, { workspace, opts: { platform: 'win32' } });
        assert.ok(r && r.where === 'outside' && r.crossings.some(x => x.path === '\\\\server\\share\\x'), `${workspace}: ${c}: ${JSON.stringify(r)}`);
      }
    }
  });

  test('route: in PowerShell a network path still crosses, on every host', () => {
    for (const o of [{}, { workspace: WIN_WS, opts: { platform: 'win32' } }]) {
      for (const c of ['Copy-Item a.md \\\\server\\share\\x', 'Set-Content \\\\server\\share\\x hi']) {
        const r = scan(c, { tool: 'PowerShell', ...o });
        assert.ok(r && r.where === 'outside' && r.crossings.some(x => x.path === '\\\\server\\share\\x'), `${c}: ${JSON.stringify(r)}`);
      }
    }
  });
});

// ===== PYTHON'S % FORMATTING =====

describe('a division inside Python\'s % formatting is not a folder', POSIX, () => {
  for (const [mode, codeMode] of MODES) {
    test(`in a here-document, in -c, and with no space around the % (${mode} mode)`, () => {
      for (const c of [
        MAIN_RED.percent,
        `python3 -c 'a, b, t = 0, 1, "x"; print("%d" % (100*(b-a)/len(t)))'`,
        py('a, b, t = 0, 1, "x"', 'print("%d"%(100*(b-a)/len(t)))'),
        py('a, b, t = 0, 1, "x"', 'fmt = "%d"', 'print(fmt % (100*(b-a)/len(t)))'),
      ]) {
        assert.deepStrictEqual(places(c, { codeMode }), [], c);
      }
    });
  }

  test('a real place in the same script still crosses, inside the brackets too', () => {
    asksAsWrite(py('t = "x"', 'a, b = 0, 1', 'print("%d" % (100*(b-a)/len(t)))', 'open("/etc/x", "w").write("x")'), etc);
    asksAsWrite(py('print("%s" % (open("/etc/y", "w"),))'), real('/etc/y'));
  });

  test('Ruby\'s and Perl\'s command quotes are still read as commands', () => {
    for (const c of [
      "ruby <<'RB'\nputs %x(cat /etc/hosts)\nRB",
      "ruby <<'RB'\nhosts = %x{cat /etc/hosts}\nRB",
      "perl <<'PL'\nmy $hosts = qx (cat /etc/hosts);\nPL",
    ]) {
      assert.deepStrictEqual(places(c), [real('/etc/hosts')], c);
    }
  });

  test('route: a real absolute path that follows a / still crosses', () => {
    asksAsWrite(py('t = "x"', 'print(100*(1-0)/len(t))', 'open("/etc/x", "w").write("x")'), etc);
    asksAsWrite(py('import pathlib', 'x = pathlib.Path("a")', 'open(x / "/etc/x", "w").write("x")'), etc);
    asksAsWrite('cp notes/a.md $(pwd)/../../outside.md', real('/outside.md'), 'a path after a closing bracket in a word');
  });
});
