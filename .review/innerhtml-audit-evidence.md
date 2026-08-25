# Every innerHTML assignment in public/, and what reaches it

The renderer hardening in `Agent output cannot become script` (#192) closed one
path from agent text to the page and said so precisely. Its own header comment
names what it did not cover:

> The other 86 innerHTML assignments across public/ (99 counting the editor's
> own) are not covered by it and want a change of their own.

This is that enumeration. Every assignment is listed with the source of its
input, classified, and either fixed or closed with a stated reason.

**Line numbers are as at the branch base, `6ba7f0e`.** They drift the moment
anything on this branch lands, which is why nothing below depends on one: each
site is named by its file and the function that renders it, and the inventory
itself is a committed tool rather than a list in prose. Regenerate it with:

    node test/tools/innerhtml-sites.js

`test/unit/innerhtml-inventory.test.js` runs that tool against the
classification table on every test run and fails if the two disagree, so an
assignment added after this file is written cannot pass unclassified.

---

## The count, measured rather than carried over

Counting occurrences of `.innerHTML =` (there are no `+=` forms anywhere in
`public/`), over `.js`, `.mjs` and `.html`, at HEAD of this branch's base:

| | Sites |
|---|---|
| First-party, non-editor, excluding the renderer | 91 |
| First-party, in `public/editor/` | 14 |
| The renderer's own, in `public/markdown-render.js` | 2 |
| **First-party total** | **107** |
| Pre-built vendor bundles (`highlight.min.js` 1, `tiptap-bundle.mjs` 6) | 7 |
| Grand total under `public/` | 114 |

**This does not match the card's 86 / 99, and the difference is two things,
both checkable.** Run the same counter over the commit that shipped the
renderer:

    9549be7   other=85  editor=13  renderer=2  vendor=7
    HEAD      other=91  editor=14  renderer=2  vendor=7

So seven first-party sites have been added since that count was taken: six
outside the editor, one inside it. The remaining discrepancy is that 86 was a
LINE count and this is an OCCURRENCE count. The command in the renderer's
header is line-based and `.js`-only:

    grep -rn "innerHTML\s*=" public/ --include="*.js" | grep -v markdown-render

It reports 99 at `9549be7` and 106 at HEAD, both exactly reproducible, and both
short of the occurrence figure because two files put two assignments on one
line and because `.mjs` is outside its `--include`. The "86" in the prose is
one over the 85 the same tool measures for that area at that commit.

**The number used from here on is 107**, and the seven vendor sites are named
rather than silently dropped: they are pre-built third-party bundles that this
repository does not author and cannot escape into. `tiptap-bundle.mjs` carries
its own tracked exposure already (see SECURITY.md's note on the vendored
`js-yaml`), and `highlight.min.js` writes its own generated markup into an
element whose text it was handed. Neither is in scope for a change to code we
write, and neither is claimed as audited.

---

## What each site was judged against

Two questions, in order.

**One: what reaches this markup that the app did not itself produce?** Not "is
the author trusted". The renderer settled that question for its own input and
the answer holds here: agent output is not the user. It carries a file from the
workspace, a page an agent fetched, an agent or skill file installed from a
marketplace, and routines make agents produce it on a timer with nobody
reading it as it arrives.

**Two: is it in a position where what it carries can become something other
than text?** A value in element content, a value in an attribute, and a value
inside an inline event handler are three different questions with three
different answers, and the audit found the codebase answering all three with
whichever escaper came to hand.

### The trust boundary, stated once

These are the values treated as document text throughout, each with where it
comes from:

| Value | Where it comes from | Who can write it |
|---|---|---|
| `agent.colour`, `.icon`, `.displayName`, `.role`, `.description`, `.model` | frontmatter of `.claude/agents/*.md`, copied verbatim by `lib/agents/discovery.js` | any agent that can write that file |
| `agent.id` | the agent file's FILENAME minus `.md` (`discovery.js`) | anything that can create a file there |
| `skill.id` | the skill's DIRECTORY NAME under `.claude/skills/` | anything that can create a directory there |
| `skill.name`, `.description` | SKILL.md frontmatter | same |
| routine `name`, `schedule` | agent frontmatter | same |
| conversation `id`, `title`, `agentId` | `.rundock/conversations.json`, written from a client message with no validation of `id` | any agent with workspace file access |
| workspace file and folder names | `fs.readdirSync` over the workspace | any agent that can create a file |
| workspace paths in the picker | `~/.rundock-recent-workspaces.json` and a scan of `~/Documents`, `~/Projects`, `~/Desktop`, `~` | anything that can create a directory |
| message text, tool names, tool inputs, run errors | the runtime's stream | the model |

**The agent-file half of that table is a closed loop with no human in it.** An
agent's own response text can carry a `<!-- RUNDOCK:SAVE_AGENT name=… -->`
block; `public/markers.js` recognises it, `public/app.js` turns it into a
`save_agent` message, and `lib/protocol/handlers/team.js` validates the SLUG
and then writes `msg.content` to the file verbatim. Frontmatter written that
way is read back by `discoverAgents` on the next scan and rendered into the
chat thread. Nothing between those two points looks at the value.

`parseAgentFrontmatter` is a hand-rolled `^(\w+):\s*(.*)` line scanner that
strips a wrapping pair of quotes and validates nothing else. There is no colour
format check anywhere in `lib/`.

### The three escapers, and which position each is for

| Helper | Where | Escapes | Correct for |
|---|---|---|---|
| `esc` | `public/app.js:222` | `&` `<` `>` | element content ONLY |
| `escAttr` | `public/app.js:223` | `&` `"` `'` `<` `>` | attribute values |
| `escText` | `views/run-detail.js:58` | delegates to `esc` | element content ONLY |
| `escText` | `views/routine-editor.js:41` | `&` `<` `>` `"` `'` | attribute values |
| `escapeHtml` / `escapeAttr` | `markdown-render.js:99` / `:121` | as above | both, correctly split |
| `escapeHtml` | `editor/panels/properties.js:48` | `&` `<` `>` `"` `'` | attribute values |
| `escapeHtml` | `viewers/board-markdown.js:14` | `&` `<` `>` `"` `'` | attribute values |

**`escAttr` had one caller in the whole client before this branch**
(`views/conversations.js:188`), while attribute-position interpolations of
external data numbered in the dozens. That single fact is most of this audit.

**And no escaper is correct inside an inline event handler.** The renderer
records the reasoning already, having made the mistake and fixed it:

> The renderer used to write attacker text into an inline handler and escape it
> with a JavaScript rule (backslashes before quotes), which is the wrong
> language for the position: the browser finishes parsing the attribute, and
> decodes its character references, before any of it is JavaScript.

`escText` in `views/routine-editor.js` escapes `'` to `&#39;`, which the
tokenizer decodes back to a live `'` before the handler body is compiled. It is
attribute-safe and handler-unsafe, and it was being used for both.

---

## The classification

**107 first-party sites. 29 in group (b), 78 in group (a).** Those three
numbers are asserted in `test/unit/innerhtml-inventory.test.js` rather than
carried in prose, and the breakdown below is the tool's output:

    group (b), by cause:
        9  agent-identity
       10  inline-handler
        9  attr-escaper
        1  transform-order

    group (a), by reason:
       25  cleared            assigned '', no value at all
       16  iconConst          a module-level icon constant, assigned whole
       15  escapedText        external text, escaped for element content
        9  staticMarkup       a literal, or booleans choosing between literals
        7  appValues          numbers, booleans, or a key into a table we write
        5  renderer           external text, through the markdown renderer
        1  closedWithReason   closed with a reason rather than a fix

Group (a) is "markup built entirely from values the app itself produced
(constants, hardcoded strings, sanitised/escaped values) with no external or
agent-influenced input". **Read that to include an external value already
escaped for the position it lands in**, which is what the 15 `escapedText`
sites are: their input is agent text or a filename, and the escaper is correct
for element content, so there is nothing to change. Where a site's input is
external and passes through the markdown renderer, it is group (a) BY THAT
BOUNDARY and says so, because the renderer is the change that made that true
and its guarantee is tested.

### Group (b): the 29, by what is actually wrong

Four root causes account for all 29. Grouped that way rather than by file,
because the fix is per cause and the commits follow the causes.

**Several sites carry two causes**, and each is counted once, under the one
that decides how it is fixed. `views/team.js`'s roster, for instance, writes
an agent colour into a `style` attribute AND an agent filename into an
`onclick`; it is counted under `inline-handler` because that is the one that
cannot be answered by choosing a different escaper. The per-cause tables below
list every occurrence, so nothing is hidden by the counting rule.

#### Cause 1: agent identity written into markup with no escaping at all (9 sites)

`colour` into `style="background:…"`, and `icon` / `displayName` straight into
element content. Eight of the nine reach the page through one file.

| Site | Function | Fields |
|---|---|---|
| `chat-markup.js` (every caller) | `agentSenderHtml`, `thinkingIndicatorHtml`, `delegationDividerHtml` | colour ×5, icon ×2, displayName ×2 |
| ↳ `app.js:691`, `app.js:708` | streaming bubble, thinking bubble | via the above |
| ↳ `views/chat.js:147, 287, 301, 464` | processing, settled message, delegation divider, history replay | via the above |
| ↳ `views/conversations.js:832, 841` | reconnect mid-stream, reconnect while thinking | via the above |
| `views/conversations.js:191` | prompt pills | colour in `style=`, icon in element content |

The payload needs no attribute break for most of these. `icon: <img src=x
onerror=…>` in a frontmatter block is element content and fires as written.
`thinkingIndicatorHtml` is the earliest trigger in the app: it renders before
the first token of a response arrives.

For `colour` the payload is an attribute break, and the same string works
everywhere: `colour: red" onmouseover="…`.

**`public/chat-markup.js` is one file and eight of these sites.** Its header
said `bodyHtml` arrives pre-rendered and said nothing about the agent object,
so the agent read as app-produced when it is the opposite. Four more sites
carry the same fields and are counted under cause 2 because they carry a
worse problem as well: `views/team.js` ×3 and `views/profile.js`.

#### Cause 2: an identifier interpolated into an inline event handler (10 sites)

`onclick="fn('${id}')"` where the id is a filename or a directory name.

| Site | Handler | Identifier |
|---|---|---|
| `views/team.js:113` | `showProfile('…')` ×4 | agent filename |
| `views/team.js:146` | `startConversation('…')` | agent filename |
| `views/team.js:414` | `showProfile('…')` | agent filename |
| `views/skills.js:153` | `selectSkill('…')` | skill directory name |
| `views/skills.js:281` | `showProfile`, `addRoutineForSkill`, `startConversation`, `getElementById` | agent filename, skill directory name |
| `views/profile.js:161` | `addToTeam`, `startConversation`, `selectSkill`, `showRoutinesForAgent`, `addRoutineForAgent` | agent filename, skill directory name |
| `views/routines-panel.js:147` | `setRoutinesScope('…')` | agent filename |
| `views/routine-editor.js:264` | `routineEditorPick('…')` | `skill.id + ':' + agent.id`, two filenames |
| `views/files.js:446` | `startConversation('…')` | agent filename |
| `views/conversations.js:637` | `openConversation`, `togglePin`, `archiveConversation`, `deleteConversation`, `openConvoListMenu` | conversation id from `conversations.json` |

`views/skills.js:281` deserves naming twice: as well as four handlers, it
builds `` `skill-instructions-${s.id}` `` with no escaper and puts it into
`id="…"` AND into the handler that looks it up by that id, so the directory
name is written into a JavaScript string and an attribute in the same tag.

`views/team.js`'s three sites and `views/profile.js` also carry the whole of
cause 1: agent colour into `style=`, and icon, display name, role and (in the
profile) the frontmatter `model:` value into element content. They are fixed
for both in the same commit.

An agent file named `x');alert(1);//.md` gives `showProfile('x');alert(1);//')`.
A skill directory named `a" onmouseenter="…` needs no click at all.

`views/routines-panel.js` carries a comment claiming the agent id is "a slug
the workspace generates rather than user-written prose, so it is safe in an
attribute in a way a routine name is not". That is false as written: the id is
the on-disk filename with nothing done to it. The comment is corrected in the
same commit as the code, because a wrong reason left in place is how the next
person re-introduces this.

#### Cause 3: `esc()` used in attribute position (9 sites)

The value is escaped, and with the escaper for the wrong position: `esc` leaves
both quote characters intact, so it cannot hold an attribute closed.

| Site | Attribute | Value |
|---|---|---|
| `app.js:1367`, `app.js:1377` | `data-ws-path="…"` | a workspace path from the recents file / a directory scan |
| `views/palette.js:191` (via `paletteItemHtml`) | `style="background:…"` ×2 | agent colour |
| `views/routines.js:573, 574, 575` (via `rowHtml`) | `style="background:…"` | agent colour |
| `views/run-detail.js:155, 163` (via `headHtml`) | `style="background:…"` | agent colour |
| `views/settings.js:39` | `title="…"` | the workspace path |
| `views/skills.js:281` | `title="View …'s profile"` | agent display name |

A directory whose name contains `"` is legal on macOS and Linux, and the
workspace picker renders BEFORE a workspace has been chosen, which is before
the user has decided to trust anything.

#### Cause 4: an escaping break created after escaping ran (1 site)

`viewers/board-view.js:305`, through `renderCardHtml` in
`viewers/board-markdown.js`. The input is a kanban card title, i.e. a line of
a markdown file. It IS escaped on entry, with the full five-character rule
including both quotes. Then eight regex transforms run over the result, and the
tag and date rules emit raw `<span class="…">` into attribute values the link
and wikilink rules have already written:

    [[note #tag x]]
      -> <a class="board-wikilink" data-target="note <span class="board-tag">#tag</span> x">…

    [link](https://x/2024-01-01/y)
      -> <a href="https://x/<span class="board-date">2024-01-01</span>/y"
            target="_blank" rel="noreferrer noopener">link</a>

Measured in jsdom, not reasoned about. **This is not XSS as written**, and the
reason it is not is worth recording rather than being lucky twice: the injected
markup is a fixed `class="board-…">`, so the tokenizer ends the value at the
first quote, reads `board-tag"` as a bare attribute name, and the very next
`>` closes the start tag. The attacker gets no attribute name or value of their
own, and the rest of their text lands as element content.

What it does do, today:

- `data-target` is truncated to `note <span class="`, so the click handler that
  reads it back navigates to nothing.
- The `href` case additionally LOSES `target="_blank" rel="noreferrer noopener"`,
  because they were written after the attribute that got cut. Under Electron
  `will-navigate` catches the top-frame navigation; served from the Express
  server in an ordinary browser it does not.

The same fault applies to the emphasis rules, which were not reported and are
in the same position: `[[a *b* c]]` puts an `<em>` inside `data-target`.

It is fixed rather than closed, on the card's own rule that a false positive is
cheaper than a false negative. It is one regex-ordering change from being the
other thing, and the comment above those two rules already claims the property
the code does not have ("Done on plain escaped text before emphasis so the
spans they emit are never re-parsed", and they are not done on plain escaped text,
they are done on markup).

### Group (a): the 78, and why each is closed

By the reason, since the reason repeats. The counts are the tool's, not a
second tally kept by hand; `node test/tools/innerhtml-sites.js` prints the
per-site table these totals come from.

**Cleared, not written: 25.** `x.innerHTML = ''` with no value at all. There
is nothing to escape and nothing to construct.

`viewers/registry.js` ×5 · `viewers/board-view.js` ×5 · `app.js` ×4 ·
`views/files.js` ×3 · `views/conversations.js` ×2 ·
`editor/panels/review.js` ×2 · `editor/nodes/callout.js` ×2 ·
`editor/panels/properties.js` · `editor/panels/floating-toolbar.js`

**A module-level icon constant, assigned whole: 16.** The value is a `const`
SVG or glyph string declared at the top of the same file. No interpolation
exists at the site, so there is no position for anything to arrive in.

`views/conversations.js` ×4 (send-button glyphs) · `editor/plugins/code-copy.js`
×3 · `views/files.js` ×3 (folder glyphs and one table lookup) ·
`views/chat.js` ×2 · `markdown-render.js` ×2 · `editor/nodes/callout.js` ·
`editor/panels/review.js` · `app.js` (the theme toggle, one of two constants)

**External text, escaped for element content: 15.** The input is agent text,
a tool name, a filename or a frontmatter value, and the escaper is the right
one for where it lands.

`views/chat.js` ×7: composer text and replayed user text through `esc`; the two
Codex cards, carrying a display name and the CLI's own failure message; an
activity row carrying an MCP tool name, which is a third-party string; **the
permission card**, where the tool name, the command text, every crossing path
and up to 1500 characters of the content an agent wants to write all land in
element content through `esc`; and the resolved card, which reads its summary
back out of the DOM as `textContent` and re-escapes it.

`views/conversations.js` ×2 (a conversation title and preview; a list name) ·
`views/files.js` ×2 (folder and file names, where the PATH travels as
`dataset.path`, a property, and is never markup) · `views/find.js` (the whole
file's bytes through `escapeOverlay`; the one attribute in that markup is a
boolean choosing between two literals) · `views/team.js`, `views/skills.js`
(guide copy embedding a display name) · **`editor/panels/properties.js`**,
which renders frontmatter KEYS and VALUES through a local escaper that does
include both quotes, with a comment naming the `[[x" onmouseover=…]]` breakout
as its reason. It is the one place in the client that had already answered this
question correctly, and it is worth reading before writing any of the fixes.

**A literal, or booleans choosing between literals: 9.** No `${}` carrying a
value at all.

`views/files.js` ×3 (the changed-on-disk banner and two empty states) ·
`views/chat.js` ×2 (the auth-error card, the session divider) ·
`views/conversations.js` (the history loading line) · `views/settings.js` (the
appearance card) · `views/palette.js` (the footer hint) · `app.js` (the
collapsed update strip)

**Numbers, booleans, or a key into a table this repository writes: 7.**

`app.js` ×2 (the update strip: `Math.round` percentages, and text through
`esc`) · `views/settings.js` ×2 (the app version from package.json; the
runtimes card, whose labels are constants and whose version is regex-clamped
in `codex.js`) · `views/files.js` ×2 (`TREE_ICONS[op.kind]`, where `kind` is
one of six literals the server decides; a menu button built from
`files-menu-model.js` constants) · `editor/panels/floating-toolbar.js` (a
boolean, and an id list that is only ever membership-tested)

`views/routines.js` belongs in this paragraph in spirit and not in fact: it is
the only view that passes an INTEGER index into its inline handlers rather
than a name, which is exactly why it is the only view free of cause 2. Its
three sites are still group (b), for the colour in cause 3.

**External text, through the markdown renderer: 5.** Group (a) by the
boundary #192 built, and the only sites here where that is the whole answer.

`app.js` ×3 (`formatMd` on promoted handoff text, on the live stream, on the
final message) · `views/chat.js` (`formatMd` on the buffered stream) ·
`views/files.js` (`formatMdFull` on a file body read from disk)

**Closed with a stated reason rather than a fix: 1.**

`editor/nodes/source-markers.js` reads `innerHTML` back out of an element, runs
a regex over the serialised string, and writes it back. It is the only
read-modify-write of markup in the client, and the only site where the answer
is "closed, with a reason" rather than "fixed" or "nothing reaches it".

The reason is a configuration flag two files away. `editor/factory.js` sets
`Markdown.configure({ html: false })`, so markdown-it emits raw HTML from the
document as escaped TEXT and the element tree at that point contains only
markdown-it's own tags. That removes both classic mutation-XSS families: there
is no author-controlled `<style>`, `<script>`, `<svg>` or `<math>` to create a
raw-text or foreign-content re-entry. The serializer re-escapes text and
attribute values on the way out, so nothing escaped becomes unescaped across
the round trip; and the regex itself cannot be forged from document text,
because for `\n</code></pre>` to appear in the serialised string it has to be
real markup: the literal characters serialise as `&lt;/code&gt;`. The mutated
DOM is then consumed by ProseMirror's `DOMParser`, which builds nodes only
from registered parse rules and drops unlisted attributes, event handlers
included.

**So it is safe, and it is safe for a reason written somewhere else.** The
change made at that site is a comment recording the dependency, because
nothing there said that flipping `html: false` turns this line into a
mutation-XSS gadget on top of the direct injection it would already be. That
is the whole of the change: a site that is safe by accident of another file's
configuration is one edit away from not being, and the edit would be made in
the other file by somebody who never opens this one.


---

## What was fixed, and how each fix is shown to work

All 29 group (b) sites are fixed. The proof is a payload driven through the
real call path, in `test/unit/innerhtml-payloads.test.js`, plus the rule tests
in `test/unit/agent-colour.test.js`.

**The assertions are structural, not behavioural, and that is deliberate.**
jsdom loads no images, so an `onerror` never fires there and a test that waited
for one would pass against completely unescaped markup. What is asserted is
that the element was not created and that no attribute beginning `on` carries
anything but a fixed literal, which is the same choice the renderer's own
hardening suite made and for the same reason.

**An inline handler is not by itself a finding.** This branch does not remove
the client's 75 inline handlers; it removes every interpolation of external
data into one. So `assertInert` takes an allowlist of exact handler strings,
and a handler that grows an interpolation fails even if it still looks
familiar.

### The reverting check, per site

`git stash push -- public/chat-markup.js` and re-running the payload suite:

    without the fix: 7 of 8 fail
    with the fix:    8 of 8 pass

The one that passes both ways is `an ordinary agent still renders exactly as it
did`, which is the benign control and SHOULD be insensitive to the fix. A
control that went red with the payloads would mean the suite was measuring
whether anything changed rather than whether the right thing changed.

### What each cause's fix is

| Cause | Fix | Proof |
|---|---|---|
| agent-identity | escape for element content in `chat-markup.js`; judge the colour | `an agent cannot write script into the chat thread through its own file`, six tests |
| inline-handler | the value moves to a `data-*` attribute the handler reads back | `an id that would close the handler travels as data, not as code` |
| attr-escaper | `escAttr` for attribute position, `agentColour` for a style attribute | `a colour that is still CSS is refused, not escaped into the attribute` |
| transform-order | attribute values held in placeholders until every transform has run | five tests in `a kanban card title cannot break out of the attribute` |

### The two app.js sites

`app.js` cannot be required: it touches `document` at top level. Both of its
agent-identity sites live in the effect-executor map, so each is cut out of the
source by name and run, which is the technique `test/unit/team-sidebar.test.js`
uses for the same reason. A copy of the executor written into the test would
keep passing after `app.js` stopped carrying it.

That extraction found its own bug worth recording: code eval'd into a jsdom
window resolves free names against THAT window, not against node's `global`, so
the shared client state has to exist on both. The names are mirrored one by one
rather than copied wholesale, so a name the executor needs and the list forgets
fails as a ReferenceError instead of silently reading `undefined`.

### The colour rule is held to a property, not a payload list

A payload list goes stale the first time somebody thinks of a payload nobody
wrote down. `the property holds for anything the rule admits, not only the
corpus` builds strings out of the pattern's own character classes, keeps the
ones it admits, and requires every one of them to carry no `;`, no quote, no
angle bracket, no backslash and no `url(`. It also fails if too few strings are
admitted, because a generator that admits almost nothing proves almost nothing.

### Three mutation-harness guards were retargeted, not weakened

`mutate-routines-guards.js` and `mutate-routine-editor-guards.js` quoted
`profile.js`'s `onclick="showRoutinesForAgent('${esc(a.id)}')"` and
`onclick="addRoutineForAgent('${esc(a.id)}')"` as literal guard text, and those
are exactly the interpolations removed here. Each guard now names the new
handler and mutates it to the same broken state it always did (`(null)` and
`('')`), so each still asserts that the row carries the agent whose profile it
is on. A guard whose text is not found is reported by the harness as
unmutated and fails the run, so this could not have been left to drift.

### One thing this does NOT have, said plainly

**There is no mutation harness for the new guards.** The renderer-hardening
card set that bar and this does not meet it. The reverting check above shows
the suite notices the change as a whole; it does not show that each individual
escape and each individual `data-*` move is independently noticed, which is
precisely what a mutation table is for and precisely the gap that let two
renderer guards be removed with nothing turning red.

The reason is time rather than judgement: `npm run precommit` is about thirty
minutes on this machine, `mutate:guards` is most of it, and a new harness that
reports an unmutated guard fails the gate and costs another full cycle. That is
a bad reason for a security change to be missing its strongest instrument, and
it is written here rather than omitted so the follow-up is obvious:
`test/tools/mutate-innerhtml-guards.js`, on the shape of the six harnesses that
already exist, wired into `npm run mutate:guards`.

## Raised rather than absorbed

Found while auditing, deliberately not fixed here, each with why.

- **The 75 inline handlers remain inline.** The fix for cause 2 removes every
  interpolation from JavaScript position by moving the value into a `data-*`
  attribute the handler reads back, which is what the renderer's own hardening
  did. It does NOT remove the handlers, so it does not move the app closer to a
  Content-Security-Policy. That is a larger change and a different card.
- **`wsCard` in `app.js` inserts `${subtitle}` unescaped** into the card body.
  Both callers pass a safe value today, so it is not live; the contract is
  "caller must escape" and nothing says so at the helper.
- **`guideLine` and `soleOwnerLine` use `String.replace` with a string
  replacement**, so a display name containing `$&` or `` $` `` is re-read as a
  replacement pattern. A copy-integrity bug, not an injection one:
  `routines-model.js` already uses the function form and is correct.
- **`views/profile.js` builds a CSS selector by interpolation** from the same
  unescaped agent id. A quote there throws rather than injects, and breaks the
  sidebar highlight.
- **`editor/panels/review.js:541` interpolates a ProseMirror position into a
  selector.** Guarded by `Number.isInteger` upstream; worth a coercion at the
  site.
- **Colour is judged, not escaped, and that decision is only as good as its
  grammar.** A value that passes is written into a `style` attribute as-is. The
  grammar is anchored at both ends and admits no `;`, no `url(`, and no
  whitespace beyond what the functional notations need, so a passing value
  cannot carry a second declaration. If it is ever widened, that property is
  what has to survive.
