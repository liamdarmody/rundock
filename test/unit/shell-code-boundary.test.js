'use strict';
// What the shell check reads in a command that carries code or text for
// another program, and what it leaves alone.
//
// The check reads a command's words for places outside the workspace. Code
// handed to an interpreter is full of words that are not places: a division
// (`int(ms)/1000`), a join on a separator (`'/'.join(parts)`), an escape
// string (`"\n\n"`). Read as paths, each one raised an "outside your
// workspace" card, and a shell card can never be remembered, so an unattended
// run stopped at every one of them. The fixtures here are made up, in the
// shapes those commands took.
//
// The same check is the tripwire for a real read, and on Windows the only
// one, so every rule that quiets a false card sits beside a test proving the
// true card it must keep.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hook = require('../../scripts/permission-hook.js');
const fx = require('../helpers/code-mode-fixture.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-code-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, 'home');
const ws = path.join(home, 'Workspace');
fs.mkdirSync(path.join(ws, '.rundock', 'scratch', 'data'), { recursive: true });
fs.mkdirSync(path.join(ws, '.rundock', 'scratch', 'tools'), { recursive: true });

const MODES = [['Notes', false], ['Code', true]];
const scan = (command, { tool = 'Bash', codeMode = false, workspace = ws, opts = {} } = {}) =>
  hook.classifyShellAccess(tool, { command }, workspace, [], home, false, { codeMode, ...opts });
const places = (command, o) => {
  const r = scan(command, o);
  return r ? r.crossings.map(c => c.path) : [];
};
const real = p => hook.canonicalize(p);

describe('a backslash in a Bash word on a POSIX host is not a Windows separator', () => {
  for (const [mode, codeMode] of MODES) {
    test(`escape strings with more than one escape reach nothing (${mode} mode)`, () => {
      for (const c of [
        "printf '\\n\\n'",
        'printf "\\n== %s: %s" name count',
        "printf '%s\\n## Summary\\n' x",
        "tr -s '\\n\\n' '\\n' < notes.txt",
        "echo 'a\\tb\\tc' | cut -f2",
      ]) {
        assert.deepStrictEqual(places(c, { codeMode }), [], c);
      }
    });
  }

  test('a backslash inside quotes is part of a POSIX file name', () => {
    assert.deepStrictEqual(places("cat 'notes\\draft.md'"), []);
    assert.deepStrictEqual(places('cat "..\\..\\x.md"'), [], 'one file name with backslashes in it, inside the workspace');
  });

  test('an unquoted escape is read the way bash reads it, so the path it spells still cards', () => {
    assert.deepStrictEqual(places('cat \\/etc/hosts'), [real('/etc/hosts')]);
    assert.deepStrictEqual(places('cat ..\\/..\\/secret.txt'), [real(path.join(root, 'secret.txt'))]);
  });

  test('a drive letter or a UNC name is still a Windows path', () => {
    assert.ok(scan('cat C:\\Users\\someone\\notes.txt'), 'a drive letter');
    assert.ok(scan("cp a.md '\\\\server\\share\\a.md'"), 'a UNC name');
  });

  test('PowerShell keeps the backslash as a separator', () => {
    const r = scan('Get-Content ..\\..\\elsewhere\\x.txt', { tool: 'PowerShell' });
    assert.ok(r && r.where === 'outside');
  });

  test('a Windows workspace keeps the Windows reading, for the Bash tool too', () => {
    const winWs = 'C:\\Users\\someone\\ws';
    for (const opts of [{}, { platform: 'win32' }]) {
      const r = scan('cat ..\\..\\elsewhere\\x.txt', { workspace: winWs, opts });
      assert.ok(r && r.where === 'outside', `a backslash climb out of a Windows workspace (${JSON.stringify(opts)})`);
      assert.ok(scan('cat C:\\Users\\someone\\notes.txt', { workspace: winWs, opts }), 'a drive letter elsewhere');
    }
  });
});

// Made-up commands in the shapes the false cards came from. Each is a script
// written or run through a here-document, with words that are not places.
const SCRIPT_SAVED = "mkdir -p .rundock/scratch/tools && cat > .rundock/scratch/tools/show.py <<'PY'\n"
  + 'import re, sys\n'
  + 'def tidy(body):\n'
  + "    return re.sub(r'\\n\\s*\\n+', '\\n\\n', body)\n"
  + "stamp = int(msg['internalDate'])/1000,\n"
  + 'PY';
const JOINED_LINES = "python3 - <<'PY'\nlines = ['Subject: weekly totals', 'All quiet.']\nbody = \"\\n\\n\".join(lines)\nprint(body)\nPY";
const LABELS = "cat > labels.py <<'PY'\nfor name, count in sorted(totals.items()):\n    print(f\"\\n== {name}: {count}\")\nPY";
const PATH_JOIN = "python3 - <<'PY'\nparts = ['inbox', 'archive', '2026']\nprint('/'.join(parts))\nPY";
const DIGEST = "cat > digest.py <<'PY'\nout = '/'\nhead = \"\\n## Summary\"\nprint(head + out)\nPY";
const FIELD_SHAPES = [SCRIPT_SAVED, JOINED_LINES, LABELS, PATH_JOIN, DIGEST];

describe('a here-document fed to an interpreter or written to a file is judged by its string literals', () => {
  for (const [mode, codeMode] of MODES) {
    test(`the field shapes reach nothing (${mode} mode)`, () => {
      for (const c of FIELD_SHAPES) assert.deepStrictEqual(places(c, { codeMode }), [], c);
    });

    test(`code in other interpreters, and prose written to a file, reach nothing (${mode} mode)`, () => {
      for (const c of [
        "node - <<'JS'\nconst secs = Date.now()/1000;\nconsole.log(['a', 'b'].join('/'), '\\n\\n');\nJS",
        "ruby <<'RB'\nputs [1, 2].sum/2\nputs \"\\n== done\"\nRB",
        "perl <<'PL'\nmy $half = $total/2;\nprint \"\\n\\n\";\nPL",
        "cat > README.md <<'EOF'\nCall /status for health, or /metrics/daily for totals.\nEOF",
        "tee notes.txt > /dev/null <<'EOF'\nSplit on / and keep the last part.\nEOF",
      ]) {
        assert.deepStrictEqual(places(c, { codeMode }), [], c);
      }
    });
  }

  test('a real place in a string literal still cards, whichever way the delimiter is written', () => {
    for (const delim of ["'PY'", 'PY']) {
      const py = (code) => `python3 - <<${delim}\n${code}\nPY`;
      assert.deepStrictEqual(places(py("print(open('/etc/hosts').read())")), [real('/etc/hosts')], delim);
      assert.deepStrictEqual(places(py("import os\nopen(os.path.expanduser('~/.aws/credentials')).read()")),
        [real(path.join(home, '.aws', 'credentials'))], delim);
      assert.deepStrictEqual(places(py("import os\nopen(os.path.expandvars('$HOME/.ssh/id_rsa')).read()")),
        [real(path.join(home, '.ssh', 'id_rsa'))], delim);
      const secret = scan(py("open('~/.claude/.credentials.json'.replace('~', HOME)).read()"));
      assert.ok(secret && secret.crossings.some(c => c.secret === true), `a credential the hook treats as secret (${delim})`);
    }
  });

  test('in node, ruby and perl, and in a file written by cat or tee', () => {
    for (const c of [
      "node - <<'JS'\nrequire('fs').readFileSync('/etc/hosts', 'utf8');\nJS",
      "ruby <<'RB'\nputs File.read(\"/etc/hosts\")\nRB",
      "perl <<'PL'\nopen(my $f, '<', '/etc/hosts');\nPL",
      "cat > read.py <<'PY'\nprint(open('/etc/hosts').read())\nPY",
      "tee read.js > /dev/null <<'JS'\nrequire('fs').readFileSync(\"/etc/hosts\");\nJS",
    ]) {
      assert.deepStrictEqual(places(c), [real('/etc/hosts')], c);
    }
  });

  test('a climb out of the workspace and an answer file in a literal still count', () => {
    assert.deepStrictEqual(places("python3 - <<'PY'\nopen('../outside.txt', 'w').write('x')\nPY"), [real(path.join(home, 'outside.txt'))]);
    assert.deepStrictEqual(places("python3 - <<'PY'\nimport os\nos.chdir('..')\nPY"), [real(home)], 'a bare climb');
    const r = scan("python3 - <<'PY'\nopen('.rundock/permissions.json', 'w').write('{}')\nPY");
    assert.ok(r && r.crossings.some(c => c.answerFile === true), 'a write to the permission file from code is still the answer-file card');
  });

  test('home on its own is a place', () => {
    assert.deepStrictEqual(places("python3 - <<'PY'\nimport os\nprint(os.listdir(os.path.expanduser('~')))\nPY"), [real(home)]);
  });

  test('a Windows path in a literal is still a place', () => {
    const drive = "python3 - <<'PY'\nopen('C:\\\\Users\\\\someone\\\\.ssh\\\\id_rsa').read()\nPY";
    assert.ok(scan(drive), 'on this host');
    const winWs = 'C:\\Users\\someone\\ws';
    const win = { workspace: winWs, opts: { platform: 'win32', env: { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' } } };
    assert.ok(scan(drive, win), 'in a Windows workspace');
    assert.ok(scan("python3 - <<'PY'\nopen(os.path.expandvars('%APPDATA%\\\\Code\\\\settings.json'))\nPY", win), 'through an environment variable');
  });

  test('an apostrophe in a comment cannot swallow the code after it', () => {
    assert.deepStrictEqual(places("python3 - <<'PY'\n# don't print the whole file\nprint(open('/etc/hosts').read()[:80])\nPY"), [real('/etc/hosts')]);
  });

  test('backticks and command quotes inside the code run a shell, and are judged as commands', () => {
    for (const c of [
      "ruby <<'RB'\nputs `cat /etc/hosts`\nRB",
      "perl <<'PL'\nmy $hosts = qx(cat /etc/hosts);\nPL",
      "ruby <<'RB'\nhosts = %x(cat /etc/hosts)\nRB",
      "perl <<'PL'\nmy @files = qw(/etc/hosts);\nPL",
    ]) {
      assert.deepStrictEqual(places(c), [real('/etc/hosts')], c);
    }
  });

  test('an unquoted delimiter runs its substitutions before the interpreter starts', () => {
    for (const c of [
      'python3 - <<PY\nhosts = """$(cat /etc/hosts)"""\nPY',
      'python3 - <<PY\nhosts = """`cat /etc/hosts`"""\nPY',
      'cat > notes.md <<EOF\nHosts: $(cat /etc/hosts)\nEOF',
      'node - <<-JS\n\tconst h = `$(cat /etc/hosts)`;\n\tJS',
    ]) {
      assert.deepStrictEqual(places(c), [real('/etc/hosts')], c);
    }
  });

  test('a quoted delimiter runs nothing, so the same text is only text', () => {
    assert.deepStrictEqual(places("python3 - <<'PY'\nhosts = \"$(cat /etc/hosts)\"\nPY"), []);
  });
});

describe('a here-document fed to a shell, or to anything else, is judged as commands as before', () => {
  test('a shell reading a here-document, quoted delimiter or not', () => {
    for (const c of [
      "bash <<'SH'\ncat /etc/hosts\nSH",
      'bash <<SH\ncat /etc/hosts\nSH',
      "sh -s <<'EOF'\ncat /etc/hosts\nEOF",
      "zsh <<'EOF'\ncat /etc/hosts\nEOF",
      "bash -s -- one two <<'SH'\ncat /etc/hosts\nSH",
      "ssh build-host <<'EOF'\ncat /etc/hosts\nEOF",
      "cat <<'SH' | bash\ncat /etc/hosts\nSH",
    ]) {
      assert.deepStrictEqual(places(c), [real('/etc/hosts')], c);
    }
  });

  test('data for a script, or for a loop, is not the program', () => {
    for (const c of [
      "python3 tools/check.py <<'EOF'\n/etc/hosts\nEOF",
      "python3 -c 'import sys; print(open(sys.stdin.read().strip()).read())' <<'EOF'\n/etc/hosts\nEOF",
      "node -e 'process.stdin.pipe(process.stdout)' <<'EOF'\n/etc/hosts\nEOF",
      "while read -r f; do wc -l \"$f\"; done <<'EOF'\n/etc/hosts\nEOF",
    ]) {
      assert.deepStrictEqual(places(c), [real('/etc/hosts')], c);
    }
  });

  test('a shell script written to a file is judged as the commands it holds', () => {
    for (const c of [
      "cat > run.sh <<'SH'\ncat /etc/hosts\nSH",
      "cat > tools/run <<'EOF'\n#!/usr/bin/env bash\ncat /etc/hosts\nEOF",
      "tee Makefile > /dev/null <<'EOF'\nall:\n\tcat /etc/hosts\nEOF",
    ]) {
      assert.deepStrictEqual(places(c), [real('/etc/hosts')], c);
    }
  });
});

describe('a command that writes outside around a here-document still asks', () => {
  test('a target before the here-document, on its line, or after it', () => {
    const desktop = real(path.join(home, 'Desktop'));
    for (const [c, want] of [
      ["cat > /etc/motd.d/x <<'EOF'\nhello\nEOF", real('/etc/motd.d/x')],
      ["python3 - <<'PY' && cp out.txt ~/Desktop/\nprint('/'.join(['a', 'b']))\nPY", desktop],
      ["python3 - <<'PY'\nprint(int(t)/1000)\nPY\ncp out.txt ~/Desktop/", desktop],
    ]) {
      const r = scan(c);
      assert.ok(r && r.crossings.some(x => x.path === want && x.write === true), `${c}: ${JSON.stringify(r && r.crossings)}`);
      assert.strictEqual(r.crossings.length, 1, 'and nothing in the code beside it');
    }
  });
});

// A `cd` partway through a chain. The leading `cd` rule is unchanged and
// tested in boundary.test.js; these are about one that comes later.
describe('a cd partway through an && chain is where the words after it start', () => {
  const SAVED_THEN_RUN = `${SCRIPT_SAVED}\ncd .rundock/scratch/data && python3 ../tools/show.py thread-1`;

  for (const [mode, codeMode] of MODES) {
    test(`a script saved, then run from the folder beside it, reaches nothing (${mode} mode)`, () => {
      assert.deepStrictEqual(places(SAVED_THEN_RUN, { codeMode }), []);
      assert.deepStrictEqual(places('mkdir -p out && cd out && cat ../README.md', { codeMode }), []);
    });
  }

  // A new line or `;` before the `cd` is as good as `&&`: `X <new line> cd D
  // && Y` runs Y only once `cd D` has succeeded, from wherever X left the
  // shell, which is where it started when X holds no `cd`. After a
  // here-document the separator is the new line that ends its terminator line.
  test('a cd after a here-document, a new line or a ; moves the words after it', () => {
    const run = '\ncd .rundock/scratch/data && python3 ../tools/show.py thread-1';
    for (const c of [
      SAVED_THEN_RUN,
      `mkdir -p .rundock/scratch/tools && cat > .rundock/scratch/tools/show.py <<PY\nimport sys\nprint(sys.argv[1])\nPY${run}`,
      'make; cd .rundock/scratch/data && python3 ../tools/show.py thread-1',
      'make\ncd .rundock/scratch/data && python3 ../tools/show.py thread-1',
      "node - <<'JS'\nconst dir = process.argv[2] || 'x'; if (dir) { console.log(dir); }\nJS\ncd .rundock/scratch/data && cat ../tools/show.py",
    ]) {
      assert.deepStrictEqual(places(c), [], c);
    }
  });

  // A command found inside code (a backtick span, a command quote, what an
  // unquoted delimiter runs) is judged on its own. Spliced into the shell's
  // text, a quote inside it, like the apostrophe in a comment below, ran on
  // into the lines after the here-document and hid the `cd`.
  test('a quote inside a command found in the code cannot reach the shell text after it', () => {
    for (const delim of ["'PY'", 'PY']) {
      const c = `mkdir -p .rundock/scratch/tools && cat > .rundock/scratch/tools/show.py <<${delim}\n`
        + "# prints the `thread's` messages, one per line\nprint(1)\nPY\n"
        + 'cd .rundock/scratch/data && python3 ../tools/show.py thread-1';
      assert.deepStrictEqual(places(c), [], delim);
    }
    assert.deepStrictEqual(places("ruby -e 'puts `echo it\"s`' && cd out && cat ../README.md"), []);
  });

  test('a command found in the code that writes an answer file is still the answer-file card', () => {
    const r = scan("python3 - <<PY\n$(echo '{}' > .rundock/permissions.json)\nPY");
    assert.ok(r && r.crossings.some(c => c.answerFile === true));
  });

  test('a command run from inside the code is measured from where the command starts', () => {
    const x = real(path.join(home, 'x.txt'));
    for (const c of [
      "make && cd a/b && ruby -e 'puts `cd ../.. && cat ../x.txt`'",
      "make && cd a/b && ruby <<'RB'\nputs `cd ../.. && cat ../x.txt`\nRB",
    ]) {
      assert.ok(places(c).includes(x), `${c}: the cd inside it moves the code's own shell, so its words are measured from where the command starts`);
    }
  });

  test('code after the cd is measured from the new folder too', () => {
    assert.deepStrictEqual(places("make && cd .rundock/scratch && python3 - <<'PY'\nprint(open('../tools/show.py').read())\nPY"), []);
    assert.deepStrictEqual(places('make && cd out && python3 -c "print(open(\'../README.md\').read())"'), []);
  });

  test('a climb past the workspace from the new folder still cards', () => {
    assert.deepStrictEqual(places('make && cd .rundock/scratch && cat ../../../secret.txt'), [real(path.join(home, 'secret.txt'))]);
  });

  test('the words before the cd, and after its chain ends, start where the command does', () => {
    assert.deepStrictEqual(places('cat ../before.txt && cd out && cat ../inside.txt'), [real(path.join(home, 'before.txt'))]);
    assert.deepStrictEqual(places('make && cd out && cat ../inside.txt; cat ../after.txt'), [real(path.join(home, 'after.txt'))]);
  });

  // Each of these is less certain than a single literal `cd` the words after
  // it must follow, so the words after it are measured from where the command
  // starts, which reports `../x.txt` outside: the safe direction.
  test('anything less certain falls back to where the command starts', () => {
    const x = real(path.join(home, 'x.txt'));
    for (const c of [
      'make && cd a/b && cd ../.. && cat ../x.txt',
      'make && cd "$OUT" && cat ../x.txt',
      'make && cd out; cat ../x.txt',
      'make && cd out || cat ../x.txt',
      'false || cd out && cat ../x.txt',
      'ls | cd out && cat ../x.txt',
      'make && (cd out) && cat ../x.txt',
      'make && cd - && cat ../x.txt',
      'make && cd a/b && (cd ../.. && cat ../x.txt)',
      'make && cd a/b && x=$(cd ../.. && cat ../x.txt)',
      'make && cd a/b && \\cd ../.. && cat ../x.txt',
      'make & cd out && cat ../x.txt',
      'make\ncd out ; cat ../x.txt',
      'make\ncd out || cat ../x.txt',
    ]) {
      assert.ok(places(c).includes(x), `${c}: ${JSON.stringify(places(c))}`);
    }
  });

  test('a leading cd - is not a base either, nor one followed by a cd in a subshell', () => {
    const x = real(path.join(home, 'x.txt'));
    assert.ok(places('cd - && cat ../x.txt').includes(x));
    assert.ok(places('cd a/b && (cd ../.. && cat ../x.txt)').includes(x));
  });

  test('a cd out of the workspace is reported, and is not trusted as a base', () => {
    fs.mkdirSync(path.join(home, 'other'), { recursive: true });
    assert.deepStrictEqual(places('make && cd ../other && cat ./x.txt'), [real(path.join(home, 'other'))]);
  });
});

// Through the real hook, the way the runtime calls it: what a person would
// see, in each mode. In Notes mode every command is shown, so the question is
// whether it is shown as a crossing; in Code mode a command with no crossing
// runs with no card at all.
describe('through the real hook', () => {
  const outside = fx.outsideTempRoot();
  const SKIP = outside.skip || false;
  let world, capture, deadPort;
  before(async () => {
    if (SKIP) return;
    world = fx.buildWorld(outside.dir);
    capture = await fx.startCaptureServer();
    deadPort = await fx.closedPort();
  });
  after(async () => {
    if (capture) await capture.close();
    if (outside.dir) fs.rmSync(outside.dir, { recursive: true, force: true });
  });
  const bash = (command, codeMode) => fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command }, cwd: world.ws, codeMode });

  for (const [mode, codeMode] of MODES) {
    test(`the field shapes raise no boundary card (${mode} mode)`, { skip: SKIP }, async () => {
      for (const c of [...FIELD_SHAPES, `${SCRIPT_SAVED}\ncd .rundock/scratch/data && python3 ../tools/show.py thread-1`]) {
        const r = await bash(c, codeMode);
        assert.ok(!(r.payload && r.payload.boundary), `${c}: no crossing`);
        if (codeMode) assert.strictEqual(r.cls, 'runs', `${c}: and in Code mode no card at all`);
      }
    });

    test(`a real read in the code still raises one (${mode} mode)`, { skip: SKIP }, async () => {
      const r = await bash("python3 - <<'PY'\nprint(open('/etc/hosts').read())\nPY", codeMode);
      assert.strictEqual(r.payload && r.payload.boundary, true);
      const secret = await bash("python3 - <<'PY'\nimport os\nopen(os.path.expanduser('~/.aws/credentials')).read()\nPY", codeMode);
      assert.strictEqual(secret.payload && secret.payload.boundary, true);
      if (codeMode) assert.strictEqual(secret.dead.decision, 'deny', 'a hidden folder under home is refused when nobody can be asked');
    });
  }
});

describe('code given to an interpreter on its command line is judged by its string literals', () => {
  test('a real place in -c or -e code cards, which it did not before', () => {
    for (const c of [
      'python3 -c "print(open(\'/etc/hosts\').read())"',
      "python3 -c 'print(open(\"/etc/hosts\").read())'",
      'python3 -c"open(\'/etc/hosts\')"',
      'python3 -u -c "\nimport sys\nprint(open(\'/etc/hosts\').read())\n"',
      'node -e "require(\'fs\').readFileSync(\'/etc/hosts\')"',
      'node --eval="require(\'fs\').readFileSync(\'/etc/hosts\')"',
      'node -p "require(\'fs\').readFileSync(\'/etc/hosts\', \'utf8\')"',
      "ruby -e 'puts File.read(\"/etc/hosts\")'",
      "perl -ne 'print' -e 'open(my $f, \"<\", \"/etc/hosts\")'",
    ]) {
      assert.deepStrictEqual(places(c), [real('/etc/hosts')], c);
    }
  });

  test('home, a secret and a command run from inside the code', () => {
    assert.deepStrictEqual(places("python3 -c 'import os; open(os.path.expanduser(\"~/.aws/credentials\")).read()'"),
      [real(path.join(home, '.aws', 'credentials'))]);
    const secret = scan('python3 -c "print(open(\'$HOME/.claude/.credentials.json\').read())"');
    assert.ok(secret && secret.crossings.some(c => c.secret === true), 'a credential the hook treats as secret');
    assert.deepStrictEqual(places("ruby -e 'puts `cat /etc/hosts`'"), [real('/etc/hosts')]);
  });

  for (const [mode, codeMode] of MODES) {
    test(`the same false-card shapes reach nothing here either (${mode} mode)`, () => {
      for (const c of [
        "python3 -c \"print('/'.join(['inbox', 'archive']))\"",
        "python3 -c 'print(int(1e6)/1000)'",
        'python3 -c "print(\'\\n\\n\'.join([\'a\', \'b\']))"',
        "node -e \"console.log(['a', 'b'].join('/'), Date.now()/1000)\"",
        'python3 -m http.server 8000',
      ]) {
        assert.deepStrictEqual(places(c, { codeMode }), [], c);
      }
    });
  }
});

describe('the same code is judged the same way however it reaches the interpreter', () => {
  const SAVED = '.rundock/scratch/tools/show.py';
  const BENIGN = 'parts = ["inbox", "2026"]\nprint("/".join(parts), int(stamp)/1000, "\\n\\n== done")';
  const OUTSIDE = 'print(open("/etc/hosts").read())';
  const routes = code => [
    `cat > ${SAVED} <<'PY'\n${code}\nPY\npython3 ${SAVED}`,
    `python3 - <<'PY'\n${code}\nPY`,
    `python3 -c '${code}'`,
  ];

  test('benign code raises nothing: saved by a file tool and run, saved by a here-document and run, run from one, or given with -c', () => {
    const write = hook.classifyFileAccess('Write', { file_path: path.join(ws, SAVED), content: BENIGN }, ws, [], home);
    assert.strictEqual(write.where, 'inside', 'the file tool saves inside the workspace');
    assert.strictEqual(scan(`python3 ${SAVED}`), null, 'and running the saved script names nothing');
    for (const c of routes(BENIGN)) assert.deepStrictEqual(places(c), [], c);
  });

  test('code naming a real outside file cards on every route the check can read', () => {
    for (const c of routes(OUTSIDE)) assert.deepStrictEqual(places(c), [real('/etc/hosts')], c);
  });
});
