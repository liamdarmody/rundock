# A ( inside a word is high in Notes mode: the grades that move, the mutation run and red on main

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite, by the mutation harness whenever it runs, and by the named tool
whenever it is run. If this file and those ever disagree, they are right.

Taken on 2026-11-11 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0 and
zsh 5.9, at `3d6477c8`, the last commit to change code or tests; the commit
after it adds only this file. The merge base is `b2c87dfc`. Each test and
mutation command ran with the Code-mode fixture folder set:
`RUNDOCK_TEST_OUTSIDE_TEMP_ROOT=<a folder outside every temp folder and git tree>`.

---

## The grades that move

    node test/tools/zsh-pattern-grade-moves.js --head 3d6477c8 --check

The tool reads `public/read-only-shell.js` and `public/permissions.js` from
git at the merge base and at the head, and grades every command the
read-only tests judge, as `test/fixtures/read-only-on-main.json` records
them, with the lines this change names. Its output here:

    base b2c87dfc, head 3d6477c8
    3703 lines: 3690 recorded, 16 named, 3 in both

    high -> high: 318
    low -> low: 1596
    medium -> high: 11
    medium -> medium: 1778

    11 lines move, 7 of them recorded:
      a glob qualifier: 6
        medium -> high  "ls *(e:'cp a b':)"
        medium -> high  "ls *(e:'cp a ~/.claude/settings.json':)"
        medium -> high  "ls x(+cleanup)"
        medium -> high  "ls x(+f)"
        medium -> high  "ls 'a'*(e:'cp x ~/.claude/settings.json':)"  (named)
        medium -> high  "echo $(ls *(e:'cp x ~/.claude/settings.json':))"  (named)
      zsh's =( ): 3
        medium -> high  "cat =(cp a b)"
        medium -> high  "cat =(cp a ~/.claude/settings.json)"
        medium -> high  "cat =(cp x ~/.claude/settings.json)"  (named)
      a function definition: 1
        medium -> high  "f() { echo hi; }; f"  (named)
      another word pattern: 1
        medium -> high  "sort ~(x)"

    named lines, base -> head:
      medium -> high  "ls 'a'*(e:'cp x ~/.claude/settings.json':)"  (meant to move)
      medium -> high  "cat =(cp x ~/.claude/settings.json)"  (meant to move)
      medium -> high  "echo $(ls *(e:'cp x ~/.claude/settings.json':))"  (meant to move)
      medium -> high  "ls x(+cleanup)"  (meant to move)
      medium -> high  "f() { echo hi; }; f"  (meant to move)
      medium -> medium  "arr=(a b c)"
      medium -> medium  "echo \"$(date)\""
      medium -> medium  "x=$(git rev-parse HEAD)"
      low -> low  "grep -E \"(a|b)\" notes/a.md"
      low -> low  "find . \\( -name a -o -name b \\)"
      medium -> medium  "(cd src && ls)"
      medium -> medium  "node -e \"f()\""
      medium -> medium  "echo $((1+2))"
      medium -> medium  "diff <(ls a) <(ls b)"
      medium -> medium  "git commit -m \"$(cat <<'EOF'\nRead the line (both readings)\n\nIt's quoted.\nEOF\n)\""
      low -> low  "ls *.md"

    check: every line that moves goes to high and is marked by the view; every named line is where it is meant to be

Seven of the 3,690 recorded lines move, each from medium to high, and each
has a `(` inside a word. No line moves to low or medium, and no low line
moves at all. Every line with a bracket that starts a word, or one inside
quotes, keeps its grade.

The function definition is an intended move. `f()` puts a `(` inside a word,
so the view marks it, and Code mode's verdict already always asks about the
same line (`unreadable-command`). A function body runs whenever the name is
called, so a saved answer for the line's first word would cover code the
person never saw.

---

## What the card says

The Bash branch of `describeToolRequest` gives the reason in the card's
context sentence, the one path every Bash card already takes:

| The line | The sentence |
|---|---|
| a `(` inside a word the view read | This line has a parenthesis inside a word, which the shell can use to run hidden code, so Rundock asks every time and there is no Always allow. |
| a view that failed or stopped short | Rundock could not read this line all the way through, so it asks every time and there is no Always allow. |
| graded high as destructive first | the sentence its leading command gives, as before |

Neither sentence calls the line destructive or says it deletes.
`test/unit/zsh-pattern-cards.test.js` reads them off the drawn card in a
conversation and in a routine, and `test/unit/doc-claims.test.js` holds the
page to the card.

---

## End to end

`test/integration/zsh-pattern-saved-answer.test.js` uses the harness every
integration suite uses, `test/helpers/harness.js`: the real `server.js` in
process on a random port, and a real socket client. It runs the window's own
dispatch on that socket, cut out of `public/app.js` the way
`test/integration/powershell-read-approvals.test.js` does, so the server's
`control_request` reaches the real card code in jsdom only as the window hands
it on. `Bash:ls` is saved. The real hook is spawned in Notes mode with the
harness's temporary home, and sent
`ls 'a'*(e:'cp x <that home>/.claude/settings.json':)`.

The test asserts that the server forwards the command as the hook sent it,
that the card is drawn with Allow and Deny only and the sentence above, that
nothing is answered and the hook has no answer half a second later, and that
the person's Deny reaches the hook as a deny. A plain `ls -la` before it runs
under the saved answer with no card, so the saved answer is live in the same
setup. On `main` the second test fails with "no card was drawn": the saved
answer for `ls` allowed the line.

---

## The mutation run

    node test/tools/mutate-workspace-boundary-guards.js --rows <start>:<end>

At `3d6477c8`, every row this change adds or changes, each applied alone with
its suite run against it, with the slices `154:155`, `162:163`, `166:167` and
`180:191`. Each turned at least one test red.

| Row | Suite | Tests red |
|---|---|---|
| the view: a failure inside it leaves the line not readable | `test/unit/shell-view.test.js` | 1 |
| the view: nesting deeper than it follows is not readable | `test/unit/shell-view.test.js` | 1 |
| the real hook: a failure inside the view frees nothing | `test/unit/shell-view-hook.test.js` | 2 |
| Notes mode: a ( inside a word, outside quotes, is high | `test/unit/permissions.test.js` | 7 |
| Notes mode: a ( inside a word is marked in nested code, not only at the top of the line | `test/unit/permissions.test.js` | 2 |
| Notes mode: a view that fails is marked, so its line is high | `test/unit/permissions.test.js` | 2 |
| Notes mode: a view nested deeper than it follows is marked, so its line is high | `test/unit/permissions.test.js` | 2 |
| Notes mode: a backtick nested deeper than the view follows is marked, so its line is high | `test/unit/permissions.test.js` | 1 |
| Notes mode: a view the grader cannot ask grades its line high | `test/unit/permissions.test.js` | 1 |
| a saved answer never covers a high-risk request | `test/unit/permissions.test.js` | 8 |
| Notes mode: a line the view does not mark keeps its grade | `test/unit/permissions.test.js` | 46 |
| Notes mode: the card says why a line the bracket rule grades high asks | `test/unit/permissions.test.js` | 1 |
| Notes mode: the card says when the view could not read the line through | `test/unit/permissions.test.js` | 1 |
| Notes mode: a line graded high as destructive keeps the sentence its command gives | `test/unit/permissions.test.js` | 1 |

The new rows run `test/unit/permissions.test.js`, which other rows of the
harness already run, so each is costed at the mean of their costs by label.
The card suite and the end-to-end suite have no rows of their own; red on
`main` below covers them.

---

## Red on main

    node scripts/red-first.js --tests "RUNDOCK_TEST_OUTSIDE_TEMP_ROOT=<the same folder> \
      node --test --test-timeout=120000 \
      test/integration/zsh-pattern-saved-answer.test.js test/unit/doc-claims.test.js \
      test/unit/hook-never-crashes.test.js test/unit/permissions.test.js \
      test/unit/sdlc-gate-hardening.test.js test/unit/shell-view-shells.test.js \
      test/unit/shell-view.test.js test/unit/zsh-pattern-cards.test.js"

At `3d6477c8`, measured against `origin/main`: PROVEN. With the change, 580
tests pass; with the source put back as on `main` and the tests kept, 28 of
them fail.

---

## What zsh runs

`test/unit/shell-view-shells.test.js` runs 22 lines that hold code inside a
word under zsh where it is installed, with a marker in the code's place, and
checks that zsh ran the marker in each and that each grades high in Notes
mode. Here zsh 5.9 ran it in all 22. zsh is not installed on the CI runners,
so that half skips there with a notice, and those lines are judged against
the real shell only where zsh is installed, as here.
