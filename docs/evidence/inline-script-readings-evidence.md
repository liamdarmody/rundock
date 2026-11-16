# Three spellings in an inline script name no place: the answers that move, the mutation run and red on main

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite, by the mutation harness whenever it runs, and by the named tool
whenever it is run. If this file and those ever disagree, they are right.

Taken on 2026-11-13 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0, at
`61023b5f`, the last commit to change the hook or the tests, except the
answer-moves tool, which ran at `f2689362`: that commit changes only how the
tool writes its own workspace's folders. The commit after it adds only this
file. The merge base is `b58d0c96`. Each test, tool and mutation command
ran with the Code-mode fixture folder set:
`RUNDOCK_TEST_OUTSIDE_TEMP_ROOT=<a folder outside every temp folder and git tree>`.
The fix round at the end of this file was taken later, at `cbf51e4a`;
where its numbers and those above differ, its are the current ones.

---

## The three lines, before and after

Each line is a Python here-document an agent might send, in a workspace
`<ws>` holding `notes/a.md`. Judged through the hook's decision path by the
Code-mode fixture (`test/helpers/code-mode-fixture.js`): the real hook as its
own process, against a capture server that answers allow and against a
closed port, where nobody can be asked.

| Line | Mode | At `b58d0c96` | At the head |
|---|---|---|---|
| `V = "<ws>"`, then `sys.path.insert(0, V + "/etc/tools/lib")` | Code | card, a write to `/private/etc/tools/lib`; refused with nobody to ask | no card, runs |
| `t.split('\\n\\n')` | Code | card, a write to `\\n\n\`; refused with nobody to ask | no card, runs |
| `print("%d" % (100*(b-a)/len(t)))` | Code | card, a write to `/len`; refused with nobody to ask | no card, runs |
| each of the three | Notes | card, with the write above as its crossing | card, with no crossing |

Notes mode asks before any command that runs code, whatever it names, so
each line is still a card there; only the crossing has gone from it. With
nobody to ask, Notes mode allows ordinary access at both commits, as the
hook's comment on that path sets out. The first crossing is named under
`/private/etc` because `/etc` is a link to it on macOS.

The lines that must still ask (a hidden home folder, a launch agent, a name
assigned twice, a name from `sys.argv`, the environment or `input()`, a name
given its value inside a function, `+=`, and a joined path that climbs out)
are asked about as writes outside at both commits, and refused in Code mode
with nobody to ask (`test/unit/inline-script-readings.test.js`, "through the
hook, in Code mode and in Notes mode").

---

## The answers that move

    node test/tools/inline-script-answer-moves.js --check
    node test/tools/inline-script-answer-moves.js --tests --check

The tool compiles the hook from git at the merge base beside the hook in the
working tree, classifies every command the read-only tests judge, as
`test/fixtures/read-only-on-main.json` records them, with the lines this
change names, in Notes mode and in Code mode, and compares the answers. With
`--tests` it also runs every existing test file that calls
`classifyShellAccess`, with each call answered by both hooks. Its output
here:

    base b58d0c96, head f2689362
    7370 answers from 3685 lines (3671 recorded, 14 named), each in Notes and Code mode: 10 move
    19 recorded lines longer than 1024 characters not classified: 0 of them hold a +, a backslash, a % or a q quote word
    recorded lines that move: 0
    2003 calls from 20 existing test files (tests 1468, pass 1468, fail 0): 4 move
    answers that gain a crossing: 0
      a piece joined by +: 7
        lines (Notes)  "python3 - <<'EOF'\nimport sys\nV = \"<ws>\"\nsys.path.insert(0, V + \"/etc/tools/lib\")\nprint(open(V + \"/notes/a.md\").read())\nE..."
          loses "/private/etc/tools/lib", no crossing left
        lines (Code)  "python3 - <<'EOF'\nimport sys\nV = \"<ws>\"\nsys.path.insert(0, V + \"/etc/tools/lib\")\nprint(open(V + \"/notes/a.md\").read())\nE..."
          loses "/private/etc/tools/lib", no crossing left
        lines (Notes)  "python3 - <<'EOF'\nH = \"<home>\"\nopen(H + \"/Library/LaunchAgents/x.plist\", \"w\").write(\"x\")\nEOF"
          loses "/Library/LaunchAgents/x.plist", keeps "<home>, <home>/Library/LaunchAgents/x.plist"
        lines (Code)  "python3 - <<'EOF'\nH = \"<home>\"\nopen(H + \"/Library/LaunchAgents/x.plist\", \"w\").write(\"x\")\nEOF"
          loses "/Library/LaunchAgents/x.plist", keeps "<home>, <home>/Library/LaunchAgents/x.plist"
        lines (Notes)  "python3 - <<'EOF'\nV = \"<ws>\"\nopen(V + \"/../../etc/x\", \"w\").write(\"x\")\nEOF"
          loses "/private/etc/x", keeps "<root>/etc/x"
        lines (Code)  "python3 - <<'EOF'\nV = \"<ws>\"\nopen(V + \"/../../etc/x\", \"w\").write(\"x\")\nEOF"
          loses "/private/etc/x", keeps "<root>/etc/x"
        tests  "python3 - <<'EOF'\nV = \"<tmp>/doc-claims-inline-yKKOmJ\"\nopen(V + \"/etc/x\", \"w\")\nEOF"
          loses "/private/etc/x", no crossing left
      a word starting with two backslashes: 4
        lines (Notes)  "python3 - <<'EOF'\nt = open(\"notes/a.md\").read()\nparts = t.split('\\\\n\\\\n')\nprint(len(parts))\nEOF"
          loses "\\\\n\\n\\", no crossing left
        lines (Code)  "python3 - <<'EOF'\nt = open(\"notes/a.md\").read()\nparts = t.split('\\\\n\\\\n')\nprint(len(parts))\nEOF"
          loses "\\\\n\\n\\", no crossing left
        tests  "python3 - <<'EOF'\nt = 'a'\nparts = t.split('\\\\n\\\\n')\nEOF"
          loses "\\\\n\\n\\", no crossing left
        tests  "cp a.md '\\\\server\\share\\a.md'"
          loses "\\\\server\\share\\a.md", no crossing left
      Python's % formatting: 3
        lines (Notes)  "python3 - <<'EOF'\nt = open(\"notes/a.md\").read()\na, b = 0, len(t)\nprint(\"%d\" % (100*(b-a)/len(t)))\nEOF"
          loses "/len", no crossing left
        lines (Code)  "python3 - <<'EOF'\nt = open(\"notes/a.md\").read()\na, b = 0, len(t)\nprint(\"%d\" % (100*(b-a)/len(t)))\nEOF"
          loses "/len", no crossing left
        tests  "python3 - <<'EOF'\nt = \"a\"\nprint(\"%d\" % (100*(1-0)/len(t)))\nEOF"
          loses "/len", no crossing left
    named lines meant to move, at the head:
      Notes  "python3 - <<'EOF'\nimport sys\nV = \"<ws>\"\nsys.path.insert(0, V + \"/etc/tools/lib\")\nprint(open(V + \"/notes/a.md\").read())\nE...": no crossing
      Code   "python3 - <<'EOF'\nimport sys\nV = \"<ws>\"\nsys.path.insert(0, V + \"/etc/tools/lib\")\nprint(open(V + \"/notes/a.md\").read())\nE...": no crossing
      Notes  "python3 - <<'EOF'\nt = open(\"notes/a.md\").read()\nparts = t.split('\\\\n\\\\n')\nprint(len(parts))\nEOF": no crossing
      Code   "python3 - <<'EOF'\nt = open(\"notes/a.md\").read()\nparts = t.split('\\\\n\\\\n')\nprint(len(parts))\nEOF": no crossing
      Notes  "python3 - <<'EOF'\nt = open(\"notes/a.md\").read()\na, b = 0, len(t)\nprint(\"%d\" % (100*(b-a)/len(t)))\nEOF": no crossing
      Code   "python3 - <<'EOF'\nt = open(\"notes/a.md\").read()\na, b = 0, len(t)\nprint(\"%d\" % (100*(b-a)/len(t)))\nEOF": no crossing
    named lines that must still ask, at both commits:
      Notes  a write outside to the place it writes  "python3 - <<'EOF'\nH = \"<home>\"\nopen(H + \"/.ssh/config\", \"a\").write(\"x\")\nEOF"
      Code   a write outside to the place it writes  "python3 - <<'EOF'\nH = \"<home>\"\nopen(H + \"/.ssh/config\", \"a\").write(\"x\")\nEOF"
      Notes  a write outside to the place it writes (its answer moves)  "python3 - <<'EOF'\nH = \"<home>\"\nopen(H + \"/Library/LaunchAgents/x.plist\", \"w\").write(\"x\")\nEOF"
      Code   a write outside to the place it writes (its answer moves)  "python3 - <<'EOF'\nH = \"<home>\"\nopen(H + \"/Library/LaunchAgents/x.plist\", \"w\").write(\"x\")\nEOF"
      Notes  a write outside to the place it writes  "python3 - <<'EOF'\nV = \"<ws>\"\nV = \"/\"\nopen(V + \"/etc/x\", \"w\").write(\"x\")\nEOF"
      Code   a write outside to the place it writes  "python3 - <<'EOF'\nV = \"<ws>\"\nV = \"/\"\nopen(V + \"/etc/x\", \"w\").write(\"x\")\nEOF"
      Notes  a write outside to the place it writes  "python3 - \"<ws>\" <<'EOF'\nimport sys\nV = sys.argv[1]\nopen(V + \"/etc/x\", \"w\").write(\"x\")\nEOF"
      Code   a write outside to the place it writes  "python3 - \"<ws>\" <<'EOF'\nimport sys\nV = sys.argv[1]\nopen(V + \"/etc/x\", \"w\").write(\"x\")\nEOF"
      Notes  a write outside to the place it writes  "python3 - <<'EOF'\nimport os\nV = os.environ[\"X\"]\nopen(V + \"/etc/x\", \"w\").write(\"x\")\nEOF"
      Code   a write outside to the place it writes  "python3 - <<'EOF'\nimport os\nV = os.environ[\"X\"]\nopen(V + \"/etc/x\", \"w\").write(\"x\")\nEOF"
      Notes  a write outside to the place it writes  "python3 - <<'EOF'\nV = input()\nopen(V + \"/etc/x\", \"w\").write(\"x\")\nEOF"
      Code   a write outside to the place it writes  "python3 - <<'EOF'\nV = input()\nopen(V + \"/etc/x\", \"w\").write(\"x\")\nEOF"
      Notes  a write outside to the place it writes  "python3 - <<'EOF'\ndef save():\n    V = \"<ws>\"\n    open(V + \"/etc/x\", \"w\").write(\"x\")\nsave()\nEOF"
      Code   a write outside to the place it writes  "python3 - <<'EOF'\ndef save():\n    V = \"<ws>\"\n    open(V + \"/etc/x\", \"w\").write(\"x\")\nsave()\nEOF"
      Notes  a write outside to the place it writes  "python3 - <<'EOF'\nV = \"<ws>\"\nV += \"/../..\"\nopen(V + \"/etc/x\", \"w\").write(\"x\")\nEOF"
      Code   a write outside to the place it writes  "python3 - <<'EOF'\nV = \"<ws>\"\nV += \"/../..\"\nopen(V + \"/etc/x\", \"w\").write(\"x\")\nEOF"
      Notes  a write outside to the place it writes (its answer moves)  "python3 - <<'EOF'\nV = \"<ws>\"\nopen(V + \"/../../etc/x\", \"w\").write(\"x\")\nEOF"
      Code   a write outside to the place it writes (its answer moves)  "python3 - <<'EOF'\nV = \"<ws>\"\nopen(V + \"/../../etc/x\", \"w\").write(\"x\")\nEOF"
      Notes  a write outside to the place it writes  "python3 - <<'EOF'\nt = \"x\"\nprint(\"%d\" % (1/len(t)))\nopen(\"/etc/x\", \"w\").write(\"x\")\nEOF"
      Code   a write outside to the place it writes  "python3 - <<'EOF'\nt = \"x\"\nprint(\"%d\" % (1/len(t)))\nopen(\"/etc/x\", \"w\").write(\"x\")\nEOF"
      Notes  a write outside to the place it writes  "echo x >> ~/.zshrc"
      Code   a write outside to the place it writes  "echo x >> ~/.zshrc"

    check: every answer that moves holds one of the three shapes and gains no crossing; every named line is where it is meant to be

None of the 3,671 recorded lines moves, in either mode, and no answer
anywhere gains a crossing. The 19 recorded lines longer than a kibibyte
are each a short text repeated thousands of times, a test of the
read-only reading's length limit, and none holds a `+`, a backslash, a
`%` or a `q` quote word, so no reading this change touches can reach
them.

Of the 2,003 calls the existing test files make, 4 move. Three are this
change's own pin in `test/unit/doc-claims.test.js`. The fourth is the
assertion in `test/unit/shell-code-boundary.test.js` that a doubled
backslash in Bash on a POSIX host is a network path, which this change
rewrites: it said the opposite of the rule, and now holds the crossing on
a Windows host instead.

Two lines that must still ask move without losing their card: the piece
read alone (`/Library/LaunchAgents/x.plist`, `/etc/x`) is gone, and the
whole path it joins is still a write outside, to the place the script
writes. With the workspace in a temp folder, Code mode lets the climb out
write there, which is why the tool keeps its workspace outside every temp
folder, as the Code-mode suites do.

---

## The mutation run

    node test/tools/mutate-workspace-boundary-guards.js --rows 1162:1173

At `61023b5f`, the eleven rows this change adds, each applied alone with
`test/unit/inline-script-readings.test.js` run against it. Each turned at
least one test red.

| Row | Tests red | Caught by, among them |
|---|---|---|
| a name assigned twice is known | 1 | route: a name assigned more than once keeps today's reading |
| a name from sys.argv or the environment is known | 3 | a name from sys.argv, the environment or input() |
| a piece is dropped though the whole path is not shaped like a place | 1 | route: the piece is dropped only where the whole path it joins is judged |
| a piece is dropped though what it is joined onto is not known | 8 | a name assigned twice, however the second is written |
| a joined path is judged as a read when the call writes | 1 | the joined path is what is judged: written, it is a write inside the workspace |
| the doubled-backslash rule applies on a Windows host | 1 | route: on a Windows host a network path in Bash still crosses, quoted or not |
| the doubled-backslash rule applies to PowerShell | 1 | route: in PowerShell a network path still crosses, on every host |
| a failed reading of a joined piece drops the piece | 2 | the control failing, in process, and through the real hook in Code mode |
| a % before a space is Ruby's quote again | 6 | in a here-document, in -c, and with no space around the % |
| a % straight after a closing quote is a quote | 2 | the same test, in Notes mode and in Code mode |
| Perl's quote words lose the space before their bracket | 1 | Ruby's and Perl's command quotes are still read as commands |

The row for a name assigned twice is caught by the tests that give the name
the workspace twice, or two folders inside it. Where the second value is
`/`, the joined path `//etc/x` is not shaped like a place, so the piece is
judged alone whatever the count says, which is what the third row holds.

---

## Three breakages by hand

Each is a plausible wrong version of the change, run against the suite with
the broken hook handed to the module loader in the test process and in every
hook it starts, the working tree left as committed.

| Breakage | Tests red |
|---|---|
| a definition may be indented, so a name given its value inside a function counts as known | 2: a name given its value inside a function or a loop, or rebound with `+=`; and, through the hook in Code mode, the lines that must still ask |
| relative paths are judged from the process's own working folder | 10, among them: every line gives the same answer from the workspace and from a folder outside it |
| a word starting with `/` straight after a `)` is dropped, a narrower fix for `/len` | 1: route: a real absolute path that follows a / still crosses (`cp notes/a.md $(pwd)/../../outside.md`) |

---

## Red on main

    node scripts/red-first.js --tests "RUNDOCK_TEST_OUTSIDE_TEMP_ROOT=<the same folder> \
      node --test --test-timeout=120000 test/unit/inline-script-readings.test.js \
      test/unit/shell-code-boundary.test.js test/unit/doc-claims.test.js"

At `61023b5f`, measured against `origin/main`: PROVEN. With the change,
240 tests pass; with `scripts/permission-hook.js` and `ARCHITECTURE.md`
put back as on `main` and the tests kept, 20 of them fail: 17 in the new
suite, the rewritten UNC assertion, and the two doc-claims pins.

The 20 tests of the new suite that pass on `main` are the ones that hold
what must not change: the lines that must still ask, every way past a
joined piece, the network paths on a Windows host and in PowerShell, the
command quotes of Ruby and Perl, a real place beside each of the three
spellings, the forms that already ran, and `os.path.join` and
`pathlib`, which the hook already judged whole.

---

## What it costs

The crossing check is already slower than linear on some long commands at
the merge base, and this change leaves that as it was. Measured in process,
Code mode, at the merge base and at the head:

| Command | Characters | At `b58d0c96` | At the head |
|---|---|---|---|
| a join of n literals onto a known name, n = 1000 | 6043 | 931 ms | 1005 ms |
| a join of n literals onto a known name, n = 2000 | 12043 | 4603 ms | 3885 ms |
| n definitions of one name, n = 1000 | 9045 | 344 ms | 376 ms |
| n definitions of one name, n = 2000 | 18045 | 1417 ms | 1125 ms |
| n statements on one line before the definition, n = 1000 | 4047 | 27 ms | 28 ms |
| n statements on one line before the definition, n = 2000 | 8047 | 37 ms | 37 ms |
| n joins onto one known name, n = 1000 | 24030 | 1473 ms | 1483 ms |
| n joins onto one known name, n = 2000 | 48030 | 7287 ms | 6810 ms |

Each is the best of three runs, the two commits taking turns. Before
`55783e5f`, a join of 2,000 literals took half as long again as at the
merge base, and 2,000 definitions a third as long again, in single runs;
that commit brought both back to the merge base's cost. Doubling n
roughly quadruples the time for the joins and the definitions at both
commits: that growth is the crossing check's own, older than this change.

---

## Fix round: a name is known only where nothing unread can change it

Taken on 2026-11-13 on the same machine, with Python 3.9.6 as `python3`
(`/usr/bin/python3`, the one macOS ships), at `cbf51e4a`, the last commit to
change the hook or its tests; the commit after it adds the mutation rows,
the test cases the hand breakages called for, and this section. Each
command ran with the Code-mode fixture folder set, as above.

A piece joined onto a name given one plain string was judged as the whole
path wherever the script avoided a list of reflective words. Code the hook
never reads could still change the name, and so could the script, without
naming it. The joined reading now holds only where the script shows, by
every word it uses, that nothing can:

- **Python 3 started plainly.** `python3` (or `python3.N`) by its name,
  first in the command and first on the line, with no variable or option
  before the program; a here-document's delimiter quoted, or a `-c` word
  holding nothing the shell fills in; and not inside another shell's `-c`.
  `.venv/bin/python3` can be an interpreter the workspace holds, `python`
  can be Python 2, `-S` leaves `os` unloaded so that `./os.py` is imported
  in its place, and a command or variable before it can change where Python
  looks (`cd`, `export PYTHONPATH=.`).
- **Imports of `sys`, `os` and `os.path` only.** Python loads these before
  the script's first line, so no folder is searched for them. Every other
  module, `json` and `shutil` among them, is searched for in the folder the
  script runs in first, so a `json.py` in the workspace is imported instead.
- **Every other word of its own, or on short lists** of keywords,
  builtins and attributes that load no module, run no text and reach no
  frame or module's names; `open` and `str` called where they are named,
  with at most two and one arguments, none named or unpacked, and `open`'s
  mode a plain string of its letters, so no encoding is looked up.
- **No dunder but the main guard, no escape but the common ones, no coding
  line, nothing in a string over three quotes, a backtick or a quote word,
  and nothing Python warns of.**

The rule is in `pythonNamesClosed` (`scripts/permission-hook.js:2485`) and
`pythonBrackets` (`:2461`), the start in `feedsCode` (`:2269`),
`heredocText` (`:3282`) and `inlineCode` (`:3389`), the main guard in
`PY_MAIN_GUARD` (`:2456`), and the gate in `codeParts` (`:3230`).

### What Python loads besides an import

Measured with `/usr/bin/python3` (3.9.6), each script fed to `python3 -`
in a folder holding a module that sets `__main__.V = "/"`, the script
being `V = "<ws>"`, the trigger, then `print(V)`. For the two that load
as the script compiles, before its first line runs, the module instead
sets a trace function that changes `V` once it is given its value, and the
coding line was fed through a bash here-document, which bash 3.2 writes to a
file Python can read back. Each printed `/`:

| Trigger | Module it loads from the folder |
|---|---|
| `import json`, `import shutil`, `import helper` | `json`, `shutil`, `helper` |
| `import os` under `python3 -S` | `os` |
| `"x".encode("idna")` | `re` |
| `b"x".decode("base64")` | `base64` |
| `os.popen("true")` | `subprocess` |
| `"\N{BULLET}"`, as the script compiles | `unicodedata` |
| a first line `# -*- coding: big5 -*-`, as the script compiles | `_codecs_tw` |
| `print(bool(NotImplemented))`, a warning shown as the script runs | `_codecs_tw`, through the coding line of a file named `<stdin>` (or `<string>` for `-c`) in the folder |

The last one is the reason for the warning rule. On 3.9 a shown warning
prints the line it is about, and to find that line Python opens a file
named as the script is, in the folder it runs in, and decodes it with the
codec its coding line names; a script can write both files inside the
workspace first. `import os, sys` and `import os.path` printed `<ws>`
with an `os.py` and a `sys.py` in the folder. A `sitecustomize.py` or
`usercustomize.py` in the folder did not run, and a plain `open()` read
loaded nothing.

### Why node and Ruby keep the reading they had

`require("./helper")` in node and `require "./helper"` in Ruby run a
module the hook never reads, and either can change a global or a constant
the script joins onto. Both keep the reading from before the joined
reading: the piece is judged alone. The tests hold one of each.

### What is still trusted

- The environment the command starts in: the `PATH` that finds `python3`,
  `PYTHON*` variables set before the command, the locale, and a
  `PYTHONWARNINGS` that shows warnings Python would otherwise hide.
- The interpreter and its standard library.
- That the lists are complete for the Python that runs the script. The
  allowed words and the warning shapes were checked against 3.9.6 here; the
  completeness tests check every builtin, keyword, attribute and module of
  whatever `python3` the machine running the suite has, but a warning a
  later Python adds to a word on the lists, or a load not found here, is not
  covered by them.

### Every way past it, and what it does now

Each case joins a write outside onto `V = "<ws>"` and adds one thing that
could change `V` where the hook does not see it, or starts Python in a way
that could; the last five are scripts that must still run. "Before" is the
hook this round started from (`ea35a9a0`). A module a case imports is
really present in the test's workspace.

| Case | Before | Now |
|---|---|---|
| import helper | no crossing | a write outside |
| import booster | no crossing | a write outside |
| getattr on a frame | no crossing | a write outside |
| import __main__ | a write outside | a write outside |
| sys.modules | a write outside | a write outside |
| vars() | a write outside | a write outside |
| globals() | a write outside | a write outside |
| exec | a write outside | a write outside |
| __builtins__ | a write outside | a write outside |
| import importlib | a write outside | a write outside |
| from helper import * | a write outside | a write outside |
| a relative import | no crossing | a write outside |
| getattr with a name split in two | a write outside | a write outside |
| sys._getframe | a write outside | a write outside |
| a generator's frame | a write outside | a write outside |
| getattr spelled outside ASCII | a write outside | a write outside |
| __import__ | a write outside | a write outside |
| help, which imports what it is asked about | no crossing | a write outside |
| os.sys | a write outside | a write outside |
| a class pattern reads attributes by name | a write outside | a write outside |
| the type of a string, called with an encoding | no crossing | a write outside |
| a module named as one of Python's own (json.py in the workspace) | no crossing | a write outside |
| shutil, not loaded before the script starts | no crossing | a write outside |
| an alias | no crossing | a write outside |
| from os import | no crossing | a write outside |
| a text encoding looked up as the script runs (idna loads re) | no crossing | a write outside |
| the same with a space before the attribute | no crossing | a write outside |
| a bytes decode looked up the same way | no crossing | a write outside |
| str given an encoding | no crossing | a write outside |
| open given an encoding by position | no crossing | a write outside |
| open given an encoding by name | no crossing | a write outside |
| open given an error handler that loads unicodedata | no crossing | a write outside |
| open unpacked | no crossing | a write outside |
| open handed on as a value | no crossing | a write outside |
| a library call that imports as it runs (os.popen loads subprocess) | no crossing | a write outside |
| a \N{...} escape loads unicodedata as the script is compiled | no crossing | a write outside |
| a coding line loads its codec as the script is compiled | no crossing | a write outside |
| is with a literal | no crossing | a write outside |
| is with None (is is left out whole) | no crossing | a write outside |
| an assert given a tuple | no crossing | a write outside |
| a call on a string | no crossing | a write outside |
| a call on a number | no crossing | a write outside |
| a call on a tuple | no crossing | a write outside |
| an index on a list given a string | no crossing | a write outside |
| an index on a set | no crossing | a write outside |
| an index on None | no crossing | a write outside |
| an index on the ellipsis | no crossing | a write outside |
| a call in an f-string | no crossing | a write outside |
| an escape Python does not know | no crossing | a write outside |
| an escape bytes do not know | no crossing | a write outside |
| a number run into a word | no crossing | a write outside |
| NotImplemented in a test | no crossing | a write outside |
| an inverted bool | no crossing | a write outside |
| open's U mode | no crossing | a write outside |
| open's mode in a name | no crossing | a write outside |
| finally, which warns of a break in it | no crossing | a write outside |
| a string over three quotes | no crossing | a write outside |
| a % read as Ruby's quote | no crossing | a write outside |
| backticks in two comments | a write outside | a write outside |
| an f-string holding a string in its own quote (Python 3.12) | no crossing | a write outside |
| a t-string (Python 3.14) | no crossing | a write outside |
| an f-string that runs a call | no crossing | a write outside |
| an option (-S leaves os unloaded, found in the workspace) | no crossing | a write outside |
| a variable before it | no crossing | a write outside |
| a variable exported before it | no crossing | a write outside |
| a command before it | no crossing | a write outside |
| an interpreter by its path | no crossing | a write outside |
| python, which may be Python 2 | no crossing | a write outside |
| a here-document the shell fills in | a write outside | a write outside |
| in another shell's -c | a write outside | a write outside |
| a -c the shell fills in | a write outside | a write outside |
| a -c after an option | no crossing | a write outside |
| an option bundled with -c | no crossing | a write outside |
| a -c after a command | no crossing | a write outside |
| node | no crossing | a write outside |
| ruby | no crossing | a write outside |
| import sys | runs | runs |
| import os, sys | runs | runs |
| in -c | runs | runs |
| calls on calls, indexes on names, a list after in, a mode | runs | runs |
| a folder made and a list written | runs | runs |

### Red first

The suite as it stands at the head, run with the hook this round started
from (`ea35a9a0`) handed to the module loader, fails 14 of its 55 tests:

- a module in the workspace imported by its own name changes the name before the write
- the script changes the name through a frame it reaches by names built from strings
- every other way to the name, a frame or the script's module, without naming the name
- an import or a load of anything Python has not loaded before the script starts
- anything Python warns of, as the script compiles or runs
- code hidden in what the hook reads as a string, a quote or a backtick
- Python started any way but plainly, first on the line
- the joined reading is Python's alone: node and Ruby keep today's reading
- a builtin; a keyword; an attribute of sys, os, os.path, the builtin types and an open file; an import of every module but sys and os
- a write under the guard, on its line and in the block below, in a here-document and in -c (Notes mode, and again in Code mode)

The two guard tests were red too at `56191476`, the commit before the
guard's. The answer-moves tool's test, "the answer-moves tool counts a test
run only when it finished cleanly", was red with the tool as it was at
`ea35a9a0`: "the tool checks the run it counts". The 41 that pass with the
hook from `ea35a9a0` are the tests from before this round, the scripts
that must still run, and the dunders beside the guard, which the old word
list already caught.

### Where `/len` came from

On `main`, Python's formatting operator followed by a space and a bracket,
`"%d" % (100*(b-a)/len(t))`, was read as Ruby's `%( )` command quote:
`QUOTE_OPERATOR` (`scripts/permission-hook.js:2231` at `b58d0c96`,
`/^(?:qx|qq|qw|q|%[xqQwWiI]?)\s*([([{<])/`) let a space stand between the
`%` and the bracket, and `codeParts` (`:2995` there) took the `%` as a
quote wherever it did not follow a word character. The bracket's body,
`100*(b-a)/len(t)`, went to the caller as a command the code runs, and
commands found in code are judged word by word by `shellPathWords`
(`:1592`, called from `:3283`), which reads that body as the words
`100*`, `b-a`, `/len` and `t`. `/len` is shaped like an absolute path, so
the line was a write to `/len`. Traced on both hooks:

    at b58d0c96: QUOTE_OPERATOR on "% (100" -> ["% (", "("]
                 commands codeParts finds: ["100*(b-a)/len(t)"]
                 shellPathWords reads it as ["100*", "b-a", "/len", "t"]
    at the head: QUOTE_OPERATOR on "% (100" -> null
                 commands codeParts finds: []

At the head `QUOTE_OPERATOR` (`:2234`) wants the bracket straight after
the `%`, and `codeParts` (`:3199`) takes no quote straight after a closing
quote or bracket either. The test is "a division inside Python's %
formatting is not a folder" (`test/unit/inline-script-readings.test.js:624`),
beside the cards Ruby's and Perl's quotes keep; the mutation rows "a % before
a space is Ruby's quote again" and "a % straight after a closing quote is a
quote" turn it red.

### Notes mode before and after, for the three lines

Notes mode asks before any command that runs code, so each of the three
lines is a card at both commits; what changes is what the card carries.
Judged through the real hook process with the Code-mode fixture, at
`b58d0c96` (the hook at the merge base handed to the module loader) and at
the head:

| Line | Notes mode at `b58d0c96` | Notes mode at the head | Code mode at `b58d0c96` | Code mode at the head |
|---|---|---|---|---|
| the joined piece | card, a write outside to `/private/etc/tools/lib` | card, no crossing | card, refused with nobody to ask | runs |
| the doubled backslashes | card, a write outside to `\\n\n\` | card, no crossing | card, refused with nobody to ask | runs |
| the division in `%` formatting | card, a write outside to `/len` | card, no crossing | card, refused with nobody to ask | runs |

With nobody to ask, Notes mode allows each line at both commits. The test
is "Notes mode: each line is still asked about, now with no crossing on the
card" (`test/unit/inline-script-readings.test.js:737`), under "through the
hook, in Code mode and in Notes mode". With the merge base's hook handed to
the loader it fails on the first line: `joined: and with no crossing:
[{"path":"/private/etc/tools/lib", ..., "write":true}]`.

### The answers that move, after this change

    node test/tools/inline-script-answer-moves.js --check
    node test/tools/inline-script-answer-moves.js --tests --check

At `cbf51e4a`, against `b58d0c96`. The tool now takes a test run's count
only when the run exited 0 with no signal (`countedRun`). Its output, the
lines this section does not change cut:

    base b58d0c96, head cbf51e4a
    7370 answers from 3685 lines (3671 recorded, 14 named), each in Notes and Code mode: 10 move
    19 recorded lines longer than 1024 characters not classified: 0 of them hold a +, a backslash, a % or a q quote word
    recorded lines that move: 0
    2003 calls from 20 existing test files (tests 1468, pass 1468, fail 0): 4 move
    answers that gain a crossing: 0
      a piece joined by +: 7
      a word starting with two backslashes: 4
      Python's % formatting: 3
    ...
    check: every answer that moves holds one of the three shapes and gains no crossing; every named line is where it is meant to be

The counts are those above: no recorded line moves, every answer that moves
holds one of the three shapes, none gains a crossing, and the four calls
from the existing tests that move are the same four.

### The mutation run, after this change

    node test/tools/mutate-workspace-boundary-guards.js --rows 1162:1186
    node test/tools/mutate-workspace-boundary-guards.js --rows 989:990

At `cbf51e4a` with the rows below staged, each row applied alone with its
suite run against it. Every row turned at least one test red. The eleven
rows from before were run again, since the reading they break is now
reached only through the start and the words above; the row for code
attached to its `-c` flag searches a line this change moved, and was
updated and run against its own suite (`test/unit/shell-code-boundary.test.js`).

| Row | Tests red | Caught by, among them |
|---|---|---|
| a name assigned twice is known | 1 | route: a name assigned more than once keeps today's reading |
| a name from sys.argv or the environment is known | 3 | a name from sys.argv, the environment or input() |
| a piece is dropped though the whole path is not shaped like a place | 1 | route: the piece is dropped only where the whole path it joins is judged |
| a piece is dropped though what it is joined onto is not known | 19 | a module in the workspace imported by its own name changes the name before the write |
| a joined path is judged as a read when the call writes | 1 | the joined path is what is judged: written, it is a write inside the workspace |
| the doubled-backslash rule applies on a Windows host | 1 | route: on a Windows host a network path in Bash still crosses, quoted or not |
| the doubled-backslash rule applies to PowerShell | 1 | route: in PowerShell a network path still crosses, on every host |
| a failed reading of a joined piece drops the piece | 2 | the control failing, in process, and through the real hook in Code mode |
| a % before a space is Ruby's quote again | 6 | in a here-document, in -c, and with no space around the % |
| a % straight after a closing quote is a quote | 2 | the same test, in Notes mode and in Code mode |
| Perl's quote words lose the space before their bracket | 1 | Ruby's and Perl's command quotes are still read as commands |
| an import of any module counts as one loaded before the script starts | 3 | a module in the workspace imported by its own name changes the name before the write |
| a dunder anywhere is let through as the main guard is | 3 | a dunder anywhere but the guard, and a name given its value under the guard, still ask |
| getattr is a builtin that reaches nothing | 2 | the script changes the name through a frame it reaches by names built from strings |
| the joined reading applies to node and Ruby | 1 | the joined reading is Python's alone: node and Ruby keep today's reading |
| Python by a path or after a variable counts as started plainly | 1 | Python started any way but plainly, first on the line |
| Python after another command counts as started plainly | 1 | the same |
| a here-document the shell fills in is read for names | 1 | the same |
| -c code the shell fills in is read for names | 1 | the same |
| code in a backtick or quote word is read for names | 1 | code hidden in what the hook reads as a string, a quote or a backtick |
| a call or index on a literal or display is let through | 1 | anything Python warns of, as the script compiles or runs |
| open's mode may be anything | 1 | the same |
| an escape Python warns of is let through | 2 | the same, and an import or a load of anything Python has not loaded before the script starts |
| the main guard is a dunder like any other | 2 | a write under the guard, on its line and in the block below, in a here-document and in -c, in Notes mode and in Code mode |
| (shell code) code attached to its flag is not read | 1 | a real place in -c or -e code cards, which it did not before |

### Breakages by hand, after this change

Run as before: the broken hook handed to the module loader, in the test
process and in every hook it starts, the working tree left as committed.
The first is the earlier breakage that touches a line this change edits;
the rest are plausible wrong versions of this change that no mutation row
covers.

| Breakage | Tests red |
|---|---|
| a definition may be indented, so a name given its value inside a function counts as known | 2: a name given its value inside a function or a loop, or rebound with `+=`; and, through the hook in Code mode, the lines that must still ask |
| what a string holds between braces is not read as code | 1: code hidden in what the hook reads as a string, a quote or a backtick |
| an attribute after a space is read as a name of the script's own | 1: an import or a load of anything Python has not loaded before the script starts |
| `str` may take two arguments | 1: the same |
| a `-c` after another command counts as first on the line | 1: Python started any way but plainly, first on the line |
| an option bundled with `-c` (`-Sc`) counts as no option | 1: the same |
| a quote word does not hide code from the reading | 1: code hidden in what the hook reads as a string, a quote or a backtick |
| a call on a literal inside braces is not looked for | 1: anything Python warns of, as the script compiles or runs |
| `~` is allowed | 1: the same |
| `NotImplemented` is allowed | 2: the same, and a builtin |
| `is` is allowed | 2: the same, and a keyword |
| `assert` is allowed | 2: the same, and a keyword |
| a number run into a word is not looked for | 1: anything Python warns of, as the script compiles or runs |

Three of them first turned nothing red: the attribute after a space, the
`-c` after a command and the bundled option. The commit that adds this
section adds a test case for each, and with them each is caught. The `is`
and `assert` breakages were at first caught only by the keyword list's own
test: the cases that should have held them named the joined name outside
the join, which leaves it unknown on its own. They now use another name.

The other two earlier breakages, relative paths judged from the process's
own folder and a word after a `)` dropped, touch no line this change edits
and were not run again.

### What it costs, after this change

The new check reads the script a constant number of times, once a join
onto a known name is found, and nothing in it grows with the square of the
script. Measured in process, Code mode, with a workspace path longer than
the table above used, so the times are not comparable with it. A join of n
literals onto a known name, best of five, the hook this round started from
and the head taking turns:

| n | At `ea35a9a0` | At the head |
|---|---|---|
| 1000 | 331 ms | 359 ms |
| 2000 | 1422 ms | 1609 ms |
| 4000 | 6168 ms | 5383 ms |

The other long commands, best of three, each hook run in turn:

| Command | At `b58d0c96` | At `ea35a9a0` | At the head |
|---|---|---|---|
| n definitions of one name, n = 1000 | 2363 ms | 3077 ms | 3523 ms |
| n definitions of one name, n = 2000 | 9731 ms | 10046 ms | 10783 ms |
| n joins onto one known name, n = 1000 | 5902 ms | 6228 ms | 5048 ms |
| n joins onto one known name, n = 2000 | 14367 ms | 12883 ms | 10265 ms |
| n plain lines before one join, n = 1000 | 72 ms | 79 ms | 79 ms |
| n plain lines before one join, n = 2000 | 124 ms | 117 ms | 130 ms |

Doubling n grows the time at the head about as it grows at the other two
commits, and the plain lines grow with n alone.

### Size

Against `b58d0c96` the change adds 246 lines to `scripts/permission-hook.js`
(88 of them comments) and removes 17, and changes one line of
`ARCHITECTURE.md`: over the 120 non-test lines the change was planned at.
This round adds 158 of those hook lines. They are the closed lists of
keywords, builtins and attributes, the bracket scan that finds a call or
index Python warns of, the start conditions in `feedsCode`, `heredocText`
and `inlineCode`, and the comment that says why each holds. The round before
used a list of words to avoid; most of the ways past it above are words
that list did not name, and a list of what is allowed leaves the piece
judged alone at any word it does not name.
