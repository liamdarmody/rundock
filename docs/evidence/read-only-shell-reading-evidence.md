# Judging shell options as the shell hands them over: the mutation run and the shells

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite, and by the mutation harness whenever it runs. If this file and the
suite ever disagree, the suite is right.

Taken on 2026-11-10 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0, at
`464706fc`, the last commit to change code or tests; the commit after it adds
only this file. Each command ran with the Code-mode fixture folder set:
`RUNDOCK_TEST_OUTSIDE_TEMP_ROOT=<a folder outside every temp folder and git tree>`.

---

## What the shells run

`test/unit/shell-view-shells.test.js` runs 36 lines under bash, and under zsh
where it is installed, with a marker in the hidden command's place, and judges
every line a shell ran the marker in, on every run of the suite. Here, bash
3.2.57 ran it in 28 lines and zsh 5.9 in 35. In CI at `464706fc` (Ubuntu, Node
22 and 24), bash 5.2.21 ran it in 28 lines; zsh is not installed there, so its
half skipped with a notice, and the lines only zsh runs are judged only where
zsh is installed, as here.

What the two shells here did with a sample of those lines, with `echo RAN` as
the hidden command. RAN means it ran. The test, not this table, holds the
readings to what the shells do.

| Line | bash 3.2 | zsh 5.9 |
|---|---|---|
| `echo A $'\''; echo RAN` | RAN | RAN |
| the same, the hidden command on a line of its own | RAN | RAN |
| `echo A # it's`, the hidden line, `echo B # '` | RAN | RAN |
| a here-document whose body is `'`, then the hidden line | RAN | RAN |
| the same with a quoted delimiter and the body `it's` | RAN | RAN |
| `echo "$(echo "'")"`, the hidden line, the same again | RAN | RAN |
| the same with backticks inside the double quotes | RAN | RAN |
| `case x in x) echo RAN;; esac` | RAN | RAN |
| `ls *(e:'echo RAN':)` | error | RAN, once per file |
| `ls g1(+RANF)`, a function that prints RAN, with `g1` present | error | RAN |
| `cat =(echo RAN)` | error | RAN |
| `echo "$(cat <<'EOF'` / `)$(echo RAN)` / `EOF` / `)"` | RAN | text only |
| `echo a#b it's`, the hidden line, `echo '` (no comment) | text only | text only |

The last two rows are why the reading asks where the shells disagree, and why
a `#` inside a word starts no comment.

---

## The mutation run

    node test/tools/mutate-workspace-boundary-guards.js --rows <start>:<end>

At `464706fc`, 316 rows, each applied alone with its suite run against it, and
each turned at least one test red. They are the 53 rows this change adds
(`--rows 127:180`), every row on `public/read-only-shell.js` and
`scripts/code-mode-verdict.js`, the rows on `scripts/permission-hook.js` in
`shellCrossings`, `crossingsIn`, `shellPathWords`, `answerFileWriteWords` and
`inlineCode`, every row on the quoted-options and view hook suites, and the
rows between them where a slice joined two ranges. The slices:

    88:212 228:259 265:266 288:309 317:334 340:346 360:383 412:413 429:441
    452:465 586:613 710:728 736:738 951:956 975:979 991:993 999:1001
    1009:1010 1021:1022 1077:1081 1114:1115

Four rows this change added earlier were removed when the view made them
unable to go red: the hook's backslash-aware path pattern and its as-written
path words (that reading is gone, and the path reader is `main`'s), and the
boundary layer's rows for a quote left open and for an escaped quote, where
the view's check and the word reader's or the segmenter's each stop the line
alone; each of those keeps a row of its own through its unit tests.

---

## Red on main

    node scripts/red-first.js --tests "RUNDOCK_TEST_OUTSIDE_TEMP_ROOT=<the same folder> \
      node --test --test-timeout=120000 \
      test/unit/doc-claims.test.js test/unit/hook-never-crashes.test.js \
      test/unit/permissions.test.js test/unit/quoted-options-hook.test.js \
      test/unit/read-only-on-main.test.js test/unit/shell-view-hook.test.js \
      test/unit/shell-view-shells.test.js test/unit/shell-view.test.js \
      test/unit/workspace-boundary.test.js"

At `464706fc`, measured against `origin/main`: PROVEN. With the change, 616
tests pass; with the source put back as on `main` and the tests kept, 78 of
them fail.

---

## The shell check's growth

The best of six runs of the hook's shell check on a here-document fed to a
shell, `echo line N` on each line, in milliseconds:

| Lines | This change | Merge base |
|---|---|---|
| 1,000 | 65 | 85 |
| 2,000 | 95 | 105 |
| 4,000 | 165 | 220 |
| 8,000 | 305 | 480 |

`test/unit/shell-code-timing.test.js` holds the growth to linear.

---

## A known gap

The test in `test/unit/read-only-on-main.test.js` that checks the recording
against the graders at its base skips in CI, which checks out a single
commit, and says so on stderr. Running it there needs a deeper fetch in the CI
workflow, which a later change will make. It ran here and passed.
