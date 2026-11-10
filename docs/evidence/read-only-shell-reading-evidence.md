# Judging shell options as the shell hands them over: the mutation run and the shells

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite, and by the mutation harness whenever it runs. If this file and the
suite ever disagree, the suite is right.

Taken on 2026-11-10 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0. The
code commit is `f3988ba5`; the rows on the view's hook suite were run again at
`616a69da`, which only adds an assertion to that suite. Each slice was run
with the Code-mode fixture folder set, as:

    RUNDOCK_TEST_OUTSIDE_TEMP_ROOT=<a folder outside every temp folder and git tree> \
      node test/tools/mutate-workspace-boundary-guards.js --rows <start>:<end>

---

## What the shells run

Each line the tests use, with `echo RAN` in place of the hidden command, run
as `bash -c` and `zsh -c` (GNU bash 3.2.57, which macOS ships, and zsh 5.9).
RAN means the hidden command ran. The tests hold the readings to these
results.

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

285 rows, each applied alone with its suite run against it, and each turned
at least one test red. They are the 31 rows new with the view, the 20 this
change added before it, and 234 of the rows already on `main` that touch the
code this changes: every row on `public/read-only-shell.js` and
`scripts/code-mode-verdict.js`, and the rows on `scripts/permission-hook.js`
in `shellCrossings`, `crossingsIn`, `shellPathWords` and
`answerFileWriteWords`, with the rows between them where a slice joined two
ranges. The slices at `f3988ba5`:

    88:202 206:210 226:257 263:264 286:292 296:307 315:332 338:344 358:372
    375:381 410:411 428:430 432:437 458:463 584:606 608:611 708:726 734:736
    949:954 973:974 989:991 997:999 1007:1008 1019:1020 1075:1079 1112:1113

and at `616a69da`, `144:145` and `166:175`, each caught again.

The 31 new rows, `--rows 147:178`, with how many tests each turned red:

| Row | Tests red |
|---|---|
| the view: a quote in a comment is text | 5 |
| the view: a # starts a comment only where a word starts | 1 |
| the view: an escaped quote inside $'...' is text | 3 |
| the view: a quoted here-document's body is text | 1 |
| the view: a here-document's body is text but for its substitutions | 1 |
| the view: a double-quoted string holding a command is opened up | 2 |
| the view: a quote after a backslash is text | 1 |
| the view: a failure inside it leaves the line not readable | 1 |
| the view: a single quote inside ${...} within double quotes is not readable | 1 |
| the view: a case inside $( ) is not readable | 1 |
| the view: a substitution bash 3.2 ends elsewhere is not readable | 1 |
| the view: a ) outside every quote is seen | 1 |
| the view: a ( inside a word is one the verdict does not model | 1 |
| the view: an array's name=( is no ( inside a word | 1 |
| the view: a quote never closed is not readable | 1 |
| the view: nesting deeper than it follows is not readable | 1 |
| a line the view cannot read is not a read | 3 |
| a line with a ( or ) outside its quotes is not a read | 1 |
| a line is split as its view as well | 4 |
| the real hook: a failure inside the view frees nothing | 2 |
| the real hook: a quote in a comment hides no copy | 7 |
| the real hook: an escaped quote inside $'...' hides no copy | 5 |
| the real hook: quotes inside a substitution in double quotes hide no copy | 2 |
| the real hook reads the line's view for crossings as well | 4 |
| the real hook reads the view of each command a line's code runs | 2 |
| the verdict asks about a line the view cannot read | 1 |
| the verdict asks about a command inside a word that only zsh runs | 1 |
| the verdict judges the line's view as well | 1 |
| find, rg, tree and file: the word reader takes a quote left open for nothing it can read | 1 |
| find, rg, tree and file read a ! only as a word of its own | 1 |
| find, rg, tree and file read a ! standing alone, find's negation, as main did | 3 |

### Four rows removed, because the view made them unable to go red

An earlier run of the same selection, at `5eab511a`, caught every row but
four, all added by this change before the view:

- `the hook reads the paths of a bash line with its backslashes, so an
  escaped quote hides none` and `the hook keeps every path word of the line
  read as written`. The hook read a line's paths twice so an escaped quote
  hid none. The view makes an escaped quote a space and the crossing check
  reads it too, so with either reading undone nothing turned red. That
  reading is removed at `f3988ba5`, and the path reader is `main`'s.
- `the boundary layer frees no crossing on a find, rg, tree or file line with
  a quote left open` and `the boundary layer sees each command after an
  escaped quote`. Through the boundary layer, the view's own check and the
  word reader's or the segmenter's each stop the line alone, so undoing one
  is not seen there. Each is held by its own row through its unit tests
  (`the view: a quote never closed is not readable`, `find, rg, tree and
  file: the word reader takes a quote left open for nothing it can read`,
  `the segmenter: a backslash before a quote opens no quote`).

---

## Red on main

    node scripts/red-first.js --tests "RUNDOCK_TEST_OUTSIDE_TEMP_ROOT=<the same folder> \
      node --test --test-timeout=120000 \
      test/unit/doc-claims.test.js test/unit/hook-never-crashes.test.js \
      test/unit/permissions.test.js test/unit/quoted-options-hook.test.js \
      test/unit/read-only-on-main.test.js test/unit/shell-view-hook.test.js \
      test/unit/shell-view.test.js test/unit/workspace-boundary.test.js"

At `616a69da`, measured against `origin/main`: PROVEN. With the change, 608
tests pass; with the source put back as on `main` and the tests kept, 73 of
them fail.

---

## The shell check's growth

The best of three runs of the hook's shell check on a here-document fed to a
shell, `echo line N` on each line, in milliseconds:

| Lines | This change | Merge base |
|---|---|---|
| 1,000 | 60 | 60 |
| 2,000 | 90 | 90 |
| 4,000 | 150 | 195 |
| 8,000 | 300 | 460 |

`test/unit/shell-code-timing.test.js` holds the growth to linear.
