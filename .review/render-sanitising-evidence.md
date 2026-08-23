# Evidence: agent output cannot become script

Recorded here because a reviewer sees the change and nothing else. Every
measurement below is reproducible from a clone with the command shown next to
it; nothing here asks you to take a number on trust.

The acceptance criteria this was judged against live outside this repository,
so each one is quoted in full rather than cited by number. A reader with only
this checkout can still follow what was asked and check whether it was done.

## The hole

> **AC-1:** Script cannot execute from markdown that reaches the renderer,
> through any of the four points named.

`test/unit/markdown-render.test.js`, the group
`renderMarkdown: markdown cannot carry HTML into the page`, plus the
per-point groups below. Eleven payloads covering raw HTML at block and inline
level, inside a callout body, inside a table cell, inside a list item and
inside a wikilink label; each asserts the element was not created and no
handler attribute exists.

**Point 1 has two doors and the first version of this change closed only one.**
Escaping the `html` token covers the markup marked's own tag regex recognises.
Its inline tag tokenizer also keeps state: an opening `<pre>`, `<code>`,
`<kbd>` or `<script>` sets `lexer.state.inRawBlock`, and every text token made
while it is set carries `escaped: true`, which tells the default text renderer
to emit the characters verbatim. A tag shape the browser accepts and that regex
rejects therefore never becomes an `html` token at all: it arrives as text and
reaches innerHTML raw, with the wrapper escaped around it.

    x <code><img/src=x onerror=alert(1)></code>
      -> <p>x &lt;code&gt;<img/src=x onerror=alert(1)>&lt;/code&gt;</p>

A live image with a handler that fires on render. Verified by running it, in a
DOM, before the fix. Every raw-block opener works and `<svg/onload=...>` works
the same way. Closed by a `text` renderer override that escapes what marked
would emit verbatim and hands ordinary text back to marked untouched, so no
entity in ordinary prose is double-encoded. The group
`renderMarkdown: a raw block is not a way out of escaping` carries the payloads.

One correction to the reviewed payload. `<img/src=x/onerror=alert(1)>`, with a
second slash, creates an `img` but no handler: the browser reads
`src="x/onerror=alert(1)"` as one unquoted attribute value, since nothing
terminates it. The mechanism is right and that exact payload is one character
short of firing. Both forms are in the test, the second held to the same
assertion because it is still an element the document controls.

> **AC-2:** Event-handler attributes in agent output do not survive into the
> DOM.

Asserted in four places rather than one, because the renderer had four ways to
write an attribute: `no wikilink render carries an event-handler attribute`,
`no callout render carries an event-handler attribute`,
`a rendered code block carries no event-handler attribute`, and the sweep
inside `a tag written in the document becomes text, not an element`. Each
collects every attribute name in the rendered DOM and fails on any beginning
`on`.

> **AC-3:** A callout title containing markup renders as text.

`a callout title containing a tag renders as text` and
`a callout title cannot close the box it is written into`. Point 2's payload,
`> [!note] <img src=x onerror=alert(1)>`, is recorded in the group's header
comment with the output it produced before the change.

> **AC-4:** Wikilink target text cannot terminate the attribute or the call it
> is written into.

`a quote in a wikilink target cannot open a second attribute` and
`a wikilink target that closes the call cannot append an expression`. Both
payloads are recorded in the group's header comment with the attribute they
produced before the change. The single-quote payload is the one that broke the
old inline handler; the double-quote payload is the one that breaks the data
attribute that replaced it, and it was added after mutation showed the first
was not enough (see below).

> **AC-5:** A relative link whose filename contains a quote or a backslash
> cannot alter the handler it is rewritten into.

`character references in a filename cannot become code`,
`a quote or a backslash in a filename cannot alter the handler`, and
`a character reference in a filename stays those characters`.

Worth reading the group's header comment: a backslash cannot in fact do it,
because marked percent-encodes a backslash in an href. What does it is a
character reference, `[a](<&#39;&#41;;alert&#40;1&#41;;//.md>)`, which the
browser decodes before any of the attribute is JavaScript. The criterion names
the right defect and the wrong mechanism, and the change closes the defect.

## The decision

> **AC-6:** Whether HTML is permitted in agent markdown is recorded in the code
> with its reason, not only in a commit message.
>
> **AC-8:** A policy is present, or its absence is a stated decision naming what
> carries the risk instead.

`public/markdown-render.js`, the header block titled `THE DECISION`, at the top
of the file a reader opens to change it. It records the answer (agent markdown
may not contain HTML), what escaping costs, what a sanitiser costs, why
comments are dropped rather than escaped, and why there is no
Content-Security-Policy yet along with what carries the risk in its place.

> **AC-7:** If a sanitiser is added, it is available offline on the same terms
> as the other vendored dependencies.

Does not arise: no sanitiser was added and no dependency changed.
`git diff main -- package.json` is one line, adding the new module to the
coverage include list; `dependencies`, `devDependencies` and
`public/vendor/package.json` are untouched.

## Not breaking what works

> **AC-9:** Code blocks, tables, task lists, callouts and wikilinks still render
> as they did.
>
> **AC-11:** Highlighting still applies to fenced code.

Two existing browser tests pass unmodified and are the strongest evidence here,
because they drive the real client:

- `test/e2e/viewers.spec.js`, `a wikilink to an image or PDF in a conversation
  opens the real viewer`. This clicks a wikilink produced by this renderer, in
  Chromium, and is the end-to-end proof that the delegated listener replaced the
  inline handler without breaking navigation.
- `test/e2e/chat-table-scroll.spec.js`, which renders a wide markdown table in
  a chat message through this renderer and checks it wraps and scrolls inside
  the bubble.
- `test/e2e/chat-number-only-reply.spec.js`, which pins this renderer's
  empty-ordered-list handling in real layout.

`npx playwright test`: 162 passed. That figure and the red-first result below
are implementer-reported: neither is part of the record stamped by the gate.
What verifies them independently is CI, where the E2E job is blocking on every
pull request. Read them as pointers to that job rather than as machine record.

In the unit suite, `code blocks, tables, task lists and callouts still render`
and `highlighting still applies to fenced code`.

> **AC-15:** A test asserts the rendered output for a benign document is
> unchanged, so the fix is shown not to have rewritten ordinary markdown.

`test/fixtures/markdown-benign-before.html` is this renderer's output as it
stood on main, generated by running `test/fixtures/markdown-benign.md` through
the code in `public/app.js` before any of this.

**The fixture is the instrument, and its first two versions were blind.** Twice
this change broke ordinary markdown and this comparison stayed green, because
the document only contained the shapes the change had already been written
against: tags after plain prose, and lists in their tight form only. A fixture
that contains what its author thought of passes whatever its author wrote.

It now carries, deliberately, the shapes most likely to catch a tokenizer or an
escaping change rather than the shapes most likely to pass:

- a tag after every inline construct that can precede one: strong, emphasis,
  code span, wikilink, link, highlight, and plain prose
- the near misses that must NOT become tags: `C#programming`, `issue#42`, `a#b`
- loose lists and loose task lists, whose items the parser wraps in paragraphs,
  alongside the tight forms
- nested emphasis inside a list item, and a link and a wikilink inside one
- a bare ampersand, one written as `&amp;`, and one inside a word
- a plain wikilink, an aliased wikilink, a relative note link, a config link and
  an image, which are the constructs whose rendering was most restructured

Widening it against the pre-change renderer reported two regressions, both since
fixed, and nothing else. The complete remaining difference across the whole
document is the two attribute migrations this change declares: `onclick` on a
wikilink becoming `data-wikilink`, and `onclick` on the copy button becoming a
listener. Every element, every other attribute and every character is identical.

Its provenance is checkable rather than asserted. `npm run check:fixture` cuts
the markdown section out of `public/app.js` as it stands at the branch base,
reads it out of git history, evaluates it against the same marked build the
browser gets, and exits non-zero if the committed fixture is not what that code
produces.

It runs in the pre-commit gate and in the `Renderer guards and fixture
provenance` CI job, and deliberately NOT in the unit suite. The suite must not
depend on git history: CI checks out at depth 1, so the base commit is absent
from the clone. It was a test for one push and broke CI on exactly that, which
is recorded here rather than quietly corrected, and the tool now says so in one
sentence when it cannot read the history it needs.

Two comparisons against it:

- `the benign document keeps the structure and text it had before this change`
  compares every element, every attribute and its own text against the frozen
  output. It does not move at all. Only two attribute names are exempt,
  `onclick` and `data-wikilink`, which are the migration this change declares;
  a lost `href`, `src`, `alt`, `type` or `checked` fails it. That exemption list
  is a constant at the top of the test so it cannot quietly grow.
- `the benign document renders to the recorded bytes` compares against
  `markdown-benign.html`, the current output. That file moved exactly twice,
  both declared in the commit that moved it: two inline handlers became
  listeners, and the callout box stopped leaving a blank line behind it.

Four behaviour changes beyond ordinary rendering, each with its own test and
its reason in the source. The fourth was described as a preservation for a
while, and is not one: the old path read the href back out of finished HTML, where
marked had URI-encoded it, so `[a](<notes/My Plan.md>)` reached `openWikilink`
as `notes/My%20Plan.md`. `openWikilink` does no decoding, it matches the value
against the file tree, so an encoded name matched no file and the link opened
nothing. The destination as written is what opens now, which is what a
`[[wikilink]]` to the same file always delivered.

| What changed | Test |
|---|---|
| A wikilink in a callout title renders as text, not a link | reason in the callout tokenizer's comment |
| A workspace link's target reaches the opener as written, not URI-encoded | `a relative link still opens the same target`, last two cases |
| A tag or highlight inside fenced code is left alone | `a fenced block containing #tag or ==text== keeps its own text` |
| A tag at the start of a line keeps its line break | `a tag at the start of a line no longer swallows the line break` |

## Proof

> **AC-12:** A hostile payload is driven through `renderMarkdown` itself, not
> through a unit of the parser.

Every test calls `renderMarkdown`. `test/helpers/markdown-harness.js` builds it
from `public/markdown-render.js` wired to the same marked build the browser
gets: `lib/http-router.js` serves `node_modules/marked/lib/marked.umd.js` at
`/marked.min.js`, and the harness loads that exact file the way a script tag
does, because requiring it as CommonJS returns an empty object and would have
tested a different build.

> **AC-13:** Each of the four injection points has its own payload and its own
> assertion.

Four groups in the test file, each opening with a header comment naming its
point, the code that was wrong, and the output its payload produced before the
change. Two more groups cover two more ways in, neither of them named when the
criteria were written and both found while closing the four:

- No scheme filter on a link or image destination, so
  `[click](javascript:alert(1))` produced an anchor that ran on click and an
  image source did the same with no click at all.
- Marked's raw-block text path, which reaches innerHTML unescaped and is the
  second door into point 1 rather than a point of its own. Escaping the `html`
  token covers only the markup marked's tag regex recognises; a shape the
  browser accepts and that regex rejects arrives as text flagged
  already-escaped. `x <code><img/src=x onerror=alert(1)></code>` was a live
  image with a handler that fires on render.

> **AC-14:** Each proof fails when its own guard is removed.

`node test/tools/mutate-render-guards.js --markdown`, committed so the run can
be repeated. It removes one guard, runs the suite, and names the tests that
turn red. It exits non-zero if any mutation turns nothing red, so it is a check
and not a report.

It is also wired in, so the table below is machine-verified rather than
transcribed: `npm run mutate:guards` is a step in `npm run precommit`, and the
`Renderer guards and fixture provenance` job runs it on every pull request. It is deliberately
NOT part of `npm test`, because it runs that suite once per guard and takes
about thirty seconds; that is too much to pay on every test run and cheap once
per push. The CI job also fails if the tool leaves the renderer modified.

Run on the tree this file is committed with:

| Guard removed | Tests red | Which |
|---|---|---|
| wikilink target escaped into its attribute | 2 | `a quote in a wikilink target cannot open a second attribute`<br>`a click still reaches the opener with the same target value` |
| callout title escaped | 3 | `a callout title containing a tag renders as text`<br>`a callout title cannot close the box it is written into`<br>`no callout render carries an event-handler attribute` |
| raw-block text escaped rather than emitted verbatim | 2 | `a tag marked rejects and the browser accepts cannot survive a raw block`<br>`the escaped payload is legible as characters` |
| raw HTML escaped | 4 | `a tag written in the document becomes text, not an element`<br>`the escaped tag is still legible to the reader`<br>`a tag marked rejects and the browser accepts cannot survive a raw block`<br>`the escaped payload is legible as characters` |
| HTML comments dropped rather than escaped | 1 | `an HTML comment stays invisible instead of becoming visible text` |
| link destination checked before it is written | 1 | `a script scheme cannot reach an href or a src` |
| image destination checked before it is written | 1 | `a script scheme cannot reach an href or a src` |
| href written as an attribute value, not left to the parser | 2 | `an ordinary link keeps its destination exactly as the document wrote it`<br>`a script scheme cannot reach an href or a src` |
| workspace-file href escaped into its attribute | 1 | `a character reference in a filename stays those characters` |
| image alt escaped into its attribute | 2 | `a hostile image alt or title cannot become an attribute`<br>`an image alt and title round-trip the characters the document wrote` |
| image title escaped into its attribute | 1 | `a hostile image alt or title cannot become an attribute` |
| tag keeps the whitespace that precedes it | 4 | `the benign document renders to the recorded bytes`<br>`the benign document keeps the structure and text it had before this change`<br>`code blocks, tables, task lists and callouts still render`<br>`a tag renders after any inline construct, not only after plain prose` |
| tag offered only where a hash follows whitespace | 2 | `a hash inside a word is still not a tag`<br>`the ordinary forms render exactly as they did` |
| copy button carries no inline handler | 2 | `the benign document renders to the recorded bytes`<br>`a rendered code block carries no event-handler attribute` |
| wikilink anchor carries no inline handler | 5 | `the benign document renders to the recorded bytes`<br>`a quote in a wikilink target cannot open a second attribute`<br>`a wikilink target that closes the call cannot append an expression`<br>`no wikilink render carries an event-handler attribute`<br>`a tag written in the document becomes text, not an element` |

Two of these turned nothing red on the first run, and the tests were
strengthened rather than the result written up as a pass. Both are recorded in
the commit `Make two escaping guards testable by mutating them`:

- Removing the escaping from a wikilink target changed nothing any test could
  see, because every payload on record used a single quote, which is harmless
  inside the double-quoted attribute the target now travels in.
- Removing the escaping from a rewritten relative href changed nothing at all.
  The parser percent-encodes quotes, angle brackets and backslashes in a
  destination, so the only character that reaches the attribute able to change
  its meaning is the ampersand of a character reference, and no test used one.

One row looks untestable and is not, which is worth writing down because the
reasoning against it is nearly right. The `href written as an attribute value`
row appears to have no test, on the grounds that every payload in `a script
scheme cannot reach an href or a src` is refused by `isNavigableHref` before an
`<a href>` is written. That is
true of `javascript:` and of `java&Tab;script:`, and not of
`&#106;avascript:alert(1)`: the `#` of the character reference reads as a
fragment start, so the destination looks relative, is accepted, and the
attribute escape is the only thing standing between it and a decoded
`javascript:` href. Running the mutation shows the test go red. The row holds and
was hard to see, so `an ordinary link keeps its destination exactly as the
document wrote it` was added: a benign destination carrying an ampersand
reference, asserting the attribute round-trips undecoded. It now names both.

## Red-first and the gate

`node scripts/red-first.js --base main --tests "npm test"` reports `proven`:
1964 tests passing with the change, 2 failing without it.

Read that with its limit. Reverting deletes `public/markdown-render.js`, which
is a new file, so the suite fails at module load rather than assertion by
assertion, and the two names it reports are a whole file and a manifest test.
Red-first shows the tests notice the change; it is the mutation table above
that shows each individual guard is noticed, which is why that instrument
exists.

`npm run precommit` passes all six steps: `test:coverage`, `typecheck`,
`lint:styles`, `check:refs`, `mutate:guards`, `check:fixture`. The last two are
added by this change.

The record itself, `.precommit-gate.json`, is not tracked: it names the tree
hash the checks passed on and is per-machine, and `.gitignore` says so. It is
also not quotable here without contradicting itself, since writing its contents
into a tracked file changes the tree it names. Both commands above are the
reproduction, and both were run on the tree this file is committed with.

## Coverage, measured inside the gate

`npm run test:coverage`:

```
markdown-render.js      |  99.84 |    84.54 |   96.97 | 90
all files               |  98.50 |    87.13 |   95.85 |
```

Line 90 is the browser half of the UMD wrapper, which cannot execute under
node. It is the only uncovered line in the file. Branch coverage at 85% is the
honest number and lower than the line figure: the uncovered branches are
absent-dependency fallbacks and option defaults, not guards. Every guard in the
mutation table is covered, which is a stronger statement about this file than
its branch percentage is.

`node test/tools/coverage-areas.js coverage.lcov`: all 50 floors hold.

## Raised rather than absorbed

- The other 86 `innerHTML` assignments across `public/`, 99 counting the
  editor's own. This renderer's guarantee covers only what is rendered through
  it. Count with:
  `grep -rn "innerHTML\s*=" public/ --include="*.js" | grep -v markdown-render | wc -l`
- The 75 inline handlers elsewhere in the client, 28 in `index.html` and 47
  written by other scripts. They are what makes a Content-Security-Policy
  impossible today; the two this renderer wrote are gone.
- The streaming call site in `public/views/chat.js` renders raw response text
  without stripping Rundock's markers, which the settled paths do strip. The
  consequence is a one-frame flicker of `<!-- RUNDOCK:COMP` while a marker is
  still arriving. Recorded in the renderer's header comment with what it
  replaced, which was the rest of the message vanishing for that frame.
- `test/unit/codex-appserver.test.js` has a 200ms wall-clock failsafe that loses
  under a doubled suite load. It passes in isolation and failed one red-first
  run before passing the next. Not touched here.
