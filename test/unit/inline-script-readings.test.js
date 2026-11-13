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
const http = require('node:http');
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
  // Only sys and os are imported: a script that imports anything else keeps
  // the card (a name that code the hook never reads can change, below).
  const CALLS = [
    'sys.path.insert(0, V + "/etc/tools/lib")',
    'print(V + "/etc/x/y")',
    'open(V + "/etc/x/y", "w").write("x")',
    'os.makedirs(V + "/etc/x/y")',
    'os.rmdir(V + "/etc/x/y")',
  ];
  for (const [mode, codeMode] of MODES) {
    test(`in a here-document, in any call, a write among them (${mode} mode)`, () => {
      assert.deepStrictEqual(places(MAIN_RED.joined, { codeMode }), []);
      for (const call of CALLS) {
        assert.deepStrictEqual(places(py('import os, sys', `V = "${ws}"`, call), { codeMode }), [], call);
      }
    });

    test(`in python3 -c, first on its line or after other statements (${mode} mode)`, () => {
      for (const call of CALLS.map(c => c.replace(/"/g, "'"))) {
        for (const c of [`python3 -c "V = '${ws}'; ${call}"`, `python3 -c "import os, sys; V = '${ws}'; ${call}"`]) {
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

// ===== A NAME IS KNOWN ONLY WHERE THE SCRIPT SHOWS NOTHING CAN CHANGE IT =====
//
// Code the hook never reads can change a name: a module in the workspace,
// loaded by an import or by Python itself as the script runs, reaches the
// script's names through `__main__` or a frame, and so can the script, through
// a frame or its names reached by text it builds. The joined reading is for
// Python started plainly, and a name is known only where every word of the
// script's code is one the hook knows loads nothing and reaches nothing.
//
// Modules an agent could leave in the workspace with a write inside, each
// changing the script's name from outside it.
const MODULES = {
  'helper.py': "import __main__\n__main__.V = '/'\n",
  'booster.py': "import sys\nsys._getframe(1).f_globals['V'] = '/'\n",
  // Named as one of Python's own: the folder the script runs in is searched
  // before Python's own library.
  'json.py': "import __main__\n__main__.V = '/'\n",
  're.py': "import __main__\n__main__.V = '/'\n",
  'subprocess.py': "import __main__\n__main__.V = '/'\n",
  'helper.js': "global.V = '/';\n",
  'helper.rb': "Object.send(:remove_const, :V)\nV = '/'\n",
};
for (const [name, text] of Object.entries(MODULES)) fs.writeFileSync(path.join(ws, name), text);

describe('a name that code the hook never reads can change keeps the piece judged alone', POSIX, () => {
  const W = `V = "${ws}"`;
  const USE = 'open(V + "/etc/x", "w").write("x")';
  // A write outside to `want` (by default the bare piece, `/etc/x`).
  const keeps = (label, command, want = etc) => {
    const r = scan(command);
    assert.ok(r && r.where === 'outside' && r.grantable === false && r.crossings.some(c => c.path === want && c.write === true),
      `${label}: a write outside to ${want}\n${command}\n${JSON.stringify(r)}`);
  };
  const runs = (label, command) => assert.strictEqual(scan(command), null, `${label}: runs\n${command}`);

  test('a module in the workspace imported by its own name changes the name before the write', () => {
    keeps('import helper', py(`V = '${ws}'`, 'import helper', "open(V + '/etc/x', 'w')"));
    keeps('import booster', py(W, 'import booster', 'open(V + "/etc/x", "w")'));
  });

  test('the script changes the name through a frame it reaches by names built from strings', () => {
    keeps('getattr on a frame', py(`V = '${ws}'; import os, sys; f = getattr(sys, '_' + 'getframe')(); d = getattr(f, 'f_' + 'glo' + 'bals'); d['V'] = os.environ['HOME']; os.makedirs(V + '/etc', exist_ok=True); open(V + '/etc/../.zshrc', 'a').write('x')`), real('/etc'));
  });

  test('every other way to the name, a frame or the script\'s module, without naming the name', () => {
    for (const [label, lines] of Object.entries({
      'import __main__': ['import __main__', '__main__.V = "/"'],
      'sys.modules': ['import sys', 'sys.modules["__main__"].V = "/"'],
      'vars()': ['vars()["V"] = "/"'],
      'globals()': ['globals()["V"] = "/"'],
      'exec': ['exec(\'V = "/"\')'],
      '__builtins__': ['__builtins__.exec(\'V = "/"\')'],
      'import importlib': ['import importlib', 'importlib.import_module("helper")'],
      'from helper import *': ['from helper import *'],
      'a relative import': ['from . import helper'],
      'getattr with a name split in two': ['import sys', 'getattr(sys, "_get" + "frame")(0).f_globals["V"] = "/"'],
      'sys._getframe': ['import sys', 'sys._getframe(0).f_globals["V"] = "/"'],
      "a generator's frame": ['def g():', '    yield 1', 'gen = g()', 'gen.gi_frame.f_globals["V"] = "/"'],
      'getattr spelled outside ASCII': ['import sys', 'ｇｅｔａｔｔｒ(sys, "_getframe")(0).f_globals["V"] = "/"'],
      '__import__': ['__import__("helper")'],
      'help, which imports what it is asked about': ['help("helper")'],
      'os.sys': ['import os', 'm = os.sys.modules'],
      'a class pattern reads attributes by name': ['import sys', 'match sys:', '    case object(_getframe=gf):', '        match gf(0):', '            case object(f_globals=d):', '                d["V"] = "/"'],
      'the type of a string, called with an encoding': ['type("")(b"", "idna")'],
    })) {
      keeps(label, py(W, ...lines, USE));
    }
  });

  // Python searches the folder the script runs in, and any folder put on its
  // path, before its own library, and loads modules for more than an import.
  test('an import or a load of anything Python has not loaded before the script starts', () => {
    for (const [label, lines] of Object.entries({
      'a module named as one of Python\'s own (json.py in the workspace)': ['import json'],
      'shutil, not loaded before the script starts': ['import os, shutil, sys'],
      'an alias': ['import os as o'],
      'from os import': ['from os import path'],
      'a text encoding looked up as the script runs (idna loads re)': ['"x".encode("idna")'],
      'a bytes decode looked up the same way': ['b"".decode("base64")'],
      'str given an encoding': ['str(b"", "idna")'],
      'open given an encoding by position': ['open("notes/a.md", "r", -1, "idna")'],
      'open given an encoding by name': ['open("notes/a.md", encoding="idna")'],
      'open given an error handler that loads unicodedata': ['open("notes/b.md", "w", errors="namereplace")'],
      'open unpacked': ['a = ["notes/a.md", "r", -1, "idna"]', 'open(*a)'],
      'open handed on as a value': ['o = open', 'o("notes/a.md", "r", -1, "idna")'],
      'a library call that imports as it runs (os.popen loads subprocess)': ['import os', 'os.popen("true")'],
      'a \\N{...} escape loads unicodedata as the script is compiled': ['x = "\\N{BULLET}"'],
    })) {
      keeps(label, py(W, ...lines, USE));
    }
    keeps('a coding line loads its codec as the script is compiled', py('# -*- coding: big5 -*-', W, USE));
  });

  // On Python 3.9, the one macOS ships, a warning shown as the script compiles
  // or runs opens a file named as the script is (`<stdin>` here, `<string>`
  // for -c) in the folder it runs in, and loads the codec that file's coding
  // line names, which imports a module the workspace can hold. Each of these
  // is a warning some Python 3 gives.
  test('anything Python warns of, as the script compiles or runs', () => {
    for (const [label, lines] of Object.entries({
      'is with a literal': ['y = V is "a"'],
      'is with None (is is left out whole)': ['y = V is None'],
      'an assert given a tuple': ['assert (V, "x")'],
      'a call on a string': ['y = "a"("x")'],
      'a call on a number': ['y = 1(2)'],
      'a call on a tuple': ['y = (1, 2)(3)'],
      'an index on a list given a string': ['y = [1, 2]["a"]'],
      'an index on a set': ['y = {1}[0]'],
      'an index on None': ['y = None[0]'],
      'an index on the ellipsis': ['y = ...[0]'],
      'a call in an f-string': ['y = f"{1(2)}"'],
      'an escape Python does not know': ['y = "\\d"'],
      'an escape bytes do not know': ['y = b"\\u0041"'],
      'a number run into a word': ['y = 1if V else 2'],
      'NotImplemented in a test': ['y = bool(NotImplemented)'],
      'an inverted bool': ['y = ~True'],
      "open's U mode": ['open("notes/a.md", "rU")'],
      "open's mode in a name": ['m = "r"', 'open("notes/a.md", m)'],
      'finally, which warns of a break in it': ['for n in [1]:', '    try:', '        pass', '    finally:', '        break'],
    })) {
      keeps(label, py(W, ...lines, USE));
    }
  });

  // Each of these hides code from where the hook reads it as code, while
  // Python runs it: the hook takes a string to end at the next quote on its
  // line, and Python does not always.
  test('code hidden in what the hook reads as a string, a quote or a backtick', () => {
    for (const [label, lines] of Object.entries({
      'a string over three quotes': ['x = """', 'abc"""; y = "".encode("idna")'],
      "a % read as Ruby's quote": ['k = 3 %(len("".encode("idna")) + 1)'],
      'backticks in two comments': ['# `', 'y = "".encode("idna")', '# `'],
      'an f-string holding a string in its own quote (Python 3.12)': ['y = f"{"x" + "".encode("idna") + "y"}"'],
      'a t-string (Python 3.14)': ['y = t"{\'\'.encode(\'idna\')}"'],
      'an f-string that runs a call': ['y = f"{\'\'.encode(\'idna\')}"'],
    })) {
      keeps(label, py(W, ...lines, USE));
    }
  });

  // What Python finds as it starts, before the script's first line, comes
  // from how it is started: a path to an interpreter in the workspace, an
  // option, a variable, or a command before it on the line.
  test('Python started any way but plainly, first on the line', () => {
    const body = `${W}\n${USE}\nEOF`;
    for (const [label, c] of Object.entries({
      'an option (-S leaves os unloaded, found in the workspace)': `python3 -S - <<'EOF'\n${body}`,
      'a variable before it': `PYTHONPATH=. python3 - <<'EOF'\n${body}`,
      'a variable exported before it': `export PYTHONPATH=.; python3 - <<'EOF'\n${body}`,
      'a command before it': `cd "${ws}" && python3 - <<'EOF'\n${body}`,
      'an interpreter by its path': `.venv/bin/python3 - <<'EOF'\n${body}`,
      'python, which may be Python 2': `python - <<'EOF'\n${body}`,
      'a here-document the shell fills in': `python3 - <<EOF\n${W}\n$(cat x)\n${USE}\nEOF`,
      'in another shell\'s -c': `bash -c "python3 -c \\"V = '${ws}'; open(V + '/etc/x', 'w')\\""`,
      'a -c the shell fills in': `python3 -c "V = '${ws}'; x = '$X'; open(V + '/etc/x', 'w')"`,
      'a -c after an option': `python3 -I -c "V = '${ws}'; open(V + '/etc/x', 'w')"`,
    })) {
      keeps(label, c);
    }
  });

  // A node or Ruby script whose text the Python rules would pass: each
  // language's require runs a module it never reads.
  test('the joined reading is Python\'s alone: node and Ruby keep today\'s reading', () => {
    keeps('node', `node - <<'JS'\nvar V = "${ws}";\nrequire("./helper");\nprocess.stdout.write(V + "/etc/x");\nJS`);
    keeps('ruby', `ruby <<'RB'\nV = "${ws}"\nrequire "./helper"\nFile.write(V + "/etc/x", "x")\nRB`);
  });

  test('import sys alone, and import os, sys, with a harmless join, run', () => {
    runs('import sys', py('import sys', W, 'sys.path.insert(0, V + "/etc/tools/lib")'));
    runs('import os, sys', py('import os, sys', W, 'os.makedirs(V + "/etc/x", exist_ok=True)', USE));
    runs('in -c', `python3 -c "import os, sys; V = '${ws}'; os.makedirs(V + '/etc/x', exist_ok=True)"`);
  });

  test('a script written the common way still runs', () => {
    runs('calls on calls, indexes on names, a list after in, a mode', py(
      'import os, sys',
      W,
      'rows = [["a", "b"]]',
      'first = rows[0][1]',
      'if first in ["a", "b"] and not (len(rows) > 2):',
      '    print(sorted(os.listdir(V + "/notes"))[0], 1.5, 0x1f)',
      'open(V + "/etc/x/a.md", "a").write("x\\t" + str(2) + "\\n")',
    ));
    runs('a folder made and a list written', py(
      'import os, sys',
      W,
      '# Make the folder, then write the names in it, one to a line.',
      'os.makedirs(V + "/etc/x", exist_ok=True)',
      'names = sorted(os.listdir(V + "/notes"))',
      'with open(V + "/etc/x/list.txt", "w") as f:',
      '    for n in names:',
      '        f.write(n + "\\n")',
      'print("wrote " + str(len(names)) + f" names to {V}/etc/x", file=sys.stderr)',
    ));
  });
});

// Every builtin, keyword, attribute and module of the Python on this machine:
// each one not on the hook's allowed lists keeps the card where it appears.
// The lists here are the rule, written out: a word added to the hook's lists
// without being added here, or one Python adds that the hook does not know,
// turns this red.
describe('every word Python has, not on the allowed lists, keeps the card', () => {
  const listed = spawnSync('python3', ['-I', '-c', [
    'import builtins, keyword, sys, os, io, json',
    'out = {"builtins": [n for n in dir(builtins) if n[:1].islower()], "keywords": keyword.kwlist + getattr(keyword, "softkwlist", []),',
    '  "attributes": sorted({n for o in (sys, os, os.path, str, bytes, list, dict, set, int, float, io.TextIOWrapper, os.stat_result, type(os.environ)) for n in dir(o) if not n.startswith("__")}),',
    '  "modules": sorted(getattr(sys, "stdlib_module_names", sys.builtin_module_names))}',
    'print(json.dumps(out))',
  ].join('\n')], { encoding: 'utf8' });
  const SKIP = (process.platform === 'win32' && 'bash on a macOS or Linux host') || (listed.status !== 0 && 'no python3 on this machine') || false;
  const words = SKIP ? null : JSON.parse(listed.stdout);
  const W = `V = "${ws}"`;
  const USE = 'open(V + "/etc/x", "w").write("x")';
  const ALLOWED_BUILTINS = new Set('abs all any bool dict enumerate float int isinstance len list max min open print range repr reversed round set sorted str sum tuple zip'.split(' '));
  const CALLED_PLAINLY = new Set(['open', 'str']);
  // `import` is read on its own: only an import of sys, os or os.path passes.
  // `is`, `assert` and `finally` are left out for the warnings Python gives.
  const ALLOWED_KEYWORDS = new Set('False None True and as break continue def elif else except for if in lambda not or pass raise return try while with _'.split(' '));
  const ALLOWED_ATTRIBUTES = new Set(('argv path exit stdin stdout stderr platform version executable maxsize environ getenv getcwd listdir makedirs mkdir '
    + 'remove unlink rename replace rmdir walk stat sep join exists isdir isfile dirname basename abspath splitext getsize read write readline readlines '
    + 'close split splitlines strip lstrip rstrip startswith endswith lower upper find count append extend insert pop sort items keys values get update add').split(' '));
  const known = (line) => scan(py(W, line, USE)) === null;

  test('a builtin', { skip: SKIP }, () => {
    for (const b of words.builtins) {
      assert.strictEqual(known(`x = ${b}`), ALLOWED_BUILTINS.has(b) && !CALLED_PLAINLY.has(b), b);
    }
    assert.strictEqual(known('x = NotImplemented'), false, 'NotImplemented');
  });

  test('a keyword', { skip: SKIP }, () => {
    for (const k of words.keywords) assert.strictEqual(known(`x = ${k}`), ALLOWED_KEYWORDS.has(k), k);
  });

  test('an attribute of sys, os, os.path, the builtin types and an open file', { skip: SKIP }, () => {
    for (const a of words.attributes) assert.strictEqual(known(`x = y.${a}`), ALLOWED_ATTRIBUTES.has(a), a);
    for (const a of ALLOWED_ATTRIBUTES) assert.ok(known(`x = y.${a}`), a);
  });

  test('an import of every module but sys and os', { skip: SKIP }, () => {
    for (const m of words.modules) assert.strictEqual(known(`import ${m}`), m === 'sys' || m === 'os', m);
    assert.ok(known('import os.path'), 'os.path');
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

// ===== ALL THREE: THE WORKING FOLDER, THE RETRY, THE NEXT STEP, THE HOOK =====

describe('the working folder does not change the answer', POSIX, () => {
  const ALL = [...Object.values(MAIN_RED), ...ALREADY_RAN, ...Object.values(ASKS)];
  const from = (dir, fn) => {
    const here = process.cwd();
    process.chdir(dir);
    try { return fn(); } finally { process.chdir(here); }
  };
  test('every line gives the same answer from the workspace and from a folder outside it', () => {
    const inWs = from(ws, () => ALL.map(c => JSON.stringify(scan(c))));
    const outside = from(root, () => ALL.map(c => JSON.stringify(scan(c))));
    assert.deepStrictEqual(outside, inWs);
    for (const c of Object.values(MAIN_RED)) assert.strictEqual(from(root, () => scan(c)), null, c);
  });

  test('the retry: each line sent twice gets the same answer both times, from either working folder', () => {
    for (const dir of [ws, root]) {
      for (const c of Object.values(MAIN_RED)) {
        const first = from(dir, () => scan(c, { codeMode: true }));
        assert.deepStrictEqual(from(dir, () => scan(c, { codeMode: true })), first, c);
        assert.strictEqual(first, null, c);
      }
    }
  });
});

describe('the most common next step', POSIX, () => {
  test('the forms that already ran still run, and a read of /etc/hosts and a write to ~/.zshrc still ask', () => {
    for (const c of ALREADY_RAN) assert.strictEqual(scan(c, { codeMode: true }), null, c);
    assert.deepStrictEqual(places('cat /etc/hosts', { codeMode: true }), [real('/etc/hosts')]);
    const zshrc = scan('echo x >> ~/.zshrc', { codeMode: true });
    assert.ok(zshrc && zshrc.crossings.some(c => c.path === path.join(home, '.zshrc')), JSON.stringify(zshrc));
  });
});

// Through the hook's decision path, against a capture server and a closed
// port, the way the Code-mode hook tests judge a command.
describe('through the hook, in Code mode and in Notes mode', () => {
  const outside = fx.outsideTempRoot();
  const SKIP = outside.skip || (process.platform === 'win32' && 'bash on a macOS or Linux host') || false;
  let world, capture, deadPort, red, asks;
  before(async () => {
    if (SKIP) return;
    world = fx.buildWorld(outside.dir);
    fs.mkdirSync(path.join(world.ws, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(world.ws, 'notes', 'a.md'), 'one\n\ntwo\n');
    red = lines(world.ws);
    asks = STILL_ASKS(world.home, world.ws);
    capture = await fx.startCaptureServer();
    deadPort = await fx.closedPort();
  });
  after(async () => {
    if (capture) await capture.close();
    if (outside.dir) fs.rmSync(outside.dir, { recursive: true, force: true });
  });
  const bash = (command, codeMode = true) => fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command }, cwd: world.ws, codeMode });

  test('Code mode: the three lines run with no card', { skip: SKIP }, async () => {
    for (const [name, c] of Object.entries(red)) {
      const r = await bash(c);
      assert.strictEqual(r.cls, 'runs', `${name}: ${JSON.stringify(r.payload)}`);
    }
  });

  test('Code mode: the lines that must still ask are asked about as writes outside, and refused with nobody to ask', { skip: SKIP }, async () => {
    for (const [name, c] of Object.entries(asks)) {
      const r = await bash(c);
      assert.strictEqual(r.payload && r.payload.boundary, true, `${name}: asked about as a crossing`);
      assert.ok((r.payload.crossings || []).some(x => x.write === true), `${name}: as a write`);
      assert.strictEqual(r.dead.decision, 'deny', `${name}: refused when nobody can be asked`);
    }
  });

  // Notes mode asks before a command that runs code whatever it names. Before
  // this change the card for each line also carried a write outside; now it
  // carries none, and it is still a card.
  test('Notes mode: each line is still asked about, now with no crossing on the card', { skip: SKIP }, async () => {
    for (const [name, c] of Object.entries(red)) {
      const r = await bash(c, false);
      assert.ok(r.payload, `${name}: asked about`);
      assert.strictEqual(r.payload.boundary || false, false, `${name}: and with no crossing: ${JSON.stringify(r.payload.crossings)}`);
    }
  });

  // The person's Deny comes from a server that answers every card with a
  // deny, the shape the app's answer takes.
  test('the undo: a line that asks is denied, and the next command, a join onto the workspace, runs', { skip: SKIP }, async () => {
    const posted = [];
    const denying = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        posted.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ allow: false, reason: 'denied' }));
      });
    });
    await new Promise(r => denying.listen(0, '127.0.0.1', r));
    try {
      const input = { session_id: 'undo', transcript_path: '', permission_mode: 'acceptEdits', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: asks.assignedTwice }, cwd: world.ws };
      const denied = await fx.runHook(fx.hookEnv(world, { port: denying.address().port }), input);
      const card = posted.map(b => { try { return JSON.parse(b); } catch (e) { return null; } }).find(d => d && d.boundary === true);
      assert.ok(card && card.crossings.some(c => c.write === true), `the card was raised, as a write outside: ${posted.join('\n')}`);
      assert.strictEqual(denied.decision, 'deny');
    } finally {
      await new Promise(r => denying.close(r));
    }
    const next = await bash(red.joined);
    assert.strictEqual(next.cls, 'runs');
  });
});
