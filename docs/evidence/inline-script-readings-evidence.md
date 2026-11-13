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
