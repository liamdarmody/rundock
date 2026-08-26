# Evidence: reviewing a page that contains a fenced block

Recorded here because a reviewer sees the change and the acceptance criteria and
nothing else. The criteria live outside this repository, so each one is quoted
in full rather than cited by number alone. Every measurement below names the
command that produces it, so a reader with only a clone can reproduce it.

## The report

A documentation page held a fenced block wrapping a page of markdown, which is
the ordinary shape of a document that explains markdown. Adding inline comments
closed the fence early at the first comment. Everything after that point fell
outside the block and was then escaped: `**bold**` came back as `\*\*bold\*\*`,
backticked code gained backslashes, and link syntax was escaped through. The
damage is written on save, so the file on disk carried it.

## Diagnosis, before anything was changed

> **AC-9:** The evidence states whether the early fence close and the escaping
> are one fault or two, with the mechanism of each.

**In the incident, the early fence close and the escaping are one fault. A
second, independent fault produces an early fence close on its own, with no
comment involved, and the criteria on four-backtick and nested fences bring it
into view.** Each is named below with its mechanism.

### Fault one: an inline atom placed in a block that cannot hold one

Every review construct is an inline **atom node** (`public/editor/nodes/critic-marks.js`).
A fenced block parses to a `codeBlock`, whose content expression is `text*` and
whose `code` flag is true, so it holds text and nothing else. Read directly from
the schema rather than inferred:

    codeBlock content spec: text*  code: true
    codeBlock admits a construct node:  false
    paragraph admits a construct node:  true

`createReviewController`'s authoring commands did not ask. `addComment` tested
the selection with `selectionIsPlainText`, which asks whether the selection sits
in one textblock with no marks and no inline nodes. A selection inside a fenced
block passes that test: a `codeBlock` **is** a textblock, and its text carries no
marks. The command then ran `tr.replaceWith(from, to, [highlight, comment])`.

The insert does not fail. The editor's replace step fits the slice into the
document by closing the block that cannot hold the atoms and opening a paragraph
that can. The remainder of the fenced block is swept into that paragraph with
them. That is the early fence close, and it is the same for the standalone
branch (`tr.insert`) and for both suggestion commands.

The escaping follows from it along this route. Once the remainder of the block
is paragraph text, it is prose, and the markdown serialiser escapes prose that
would otherwise re-parse as markup. The asterisks, backticks and brackets that
were code one step earlier are now literal characters in a paragraph, so they
are written back with a backslash before each one. The serialiser is doing the
correct thing to the wrong content, so along THIS route there is no guard to
remove: the fix is to stop the content becoming prose.

**The serialiser reaches the same damage by a second route, and that one does
have a guard.** The call that writes a block's contents carries an escape flag,
and that flag is the whole of what keeps a fenced block literal. Turned on, the
prose escaper runs over the block itself. Measured by turning it on:

    in:   Use **bold** for emphasis.
          A `code` span, and a [link](https://example.com) beside it.

    out:  Use \*\*bold\*\* for emphasis.
          A \`code\` span, and a \[link\](https://example.com) beside it.

No comment is involved and the fence is intact, and the file gains eighteen
backslashes that were never in it. That is the reported escaping arriving
without the anchor fault, which is why it is committed back on a line of its own
in the mutation table below rather than only as the anchor fault's shadow.

Measured on the document shape from the report, before the change:

    in:   ```markdown
          Use **bold** for emphasis.

          A `code` span and a [link](https://example.com).
          ```

    out:  ```markdown
          Use **
          ```

          {==bold==}{>>Is bold right here?<<}{#c1}\*\* for emphasis.

          A \`code\` span and a \[link\](https://example.com).

Two controls establish that the escaping has no separate cause. A document
carrying the same fence, opened and saved with no review operation, returns byte
for byte. A comment added to a paragraph of the same document leaves the fence
untouched and adds no backslash anywhere in the file.

### Fault two: the fence marker is not carried through the round trip

The code block serialiser writes a fixed three-backtick fence and the language
word:

    state.write("```" + (node.attrs.language || "") + "\n");

The source fence marker, its length, and the rest of the info string are not
recorded on the node at parse time, so they cannot be written back. A
four-backtick fence therefore returns as a three-backtick fence. That is not
cosmetic. A four-backtick fence exists precisely because its content contains a
three-backtick fence, so shortening the opening marker means the **next** read
closes the block at the inner fence.

Measured before the change, opening and saving with no review operation at all,
one cycle per block:

    in:      ````markdown
             Here is how to write a fence:

             ```js
             const x = **1**;
             ```

             Use **bold** and `code`.
             ````

             After.

    cycle 1: the opening and closing markers are now three backticks

    cycle 2: the inner ``` closes the block early. "Use **bold** and `code`."
             is outside it as prose, and "After." has been swallowed into a
             new code block that runs to the end of the file.

The same omission rewrites a tilde fence as backticks and drops an info string
beyond the first word.

### So: one fault explains the report, and two faults have to be fixed

Fault one alone accounts for both symptoms the user saw. Fault two is a second
route to an early fence close that needs no comment, and it is inside the same
guarantee. The two have different signatures, which is what tells them apart
rather than an argument: fault one adds backslashes to the swept-out text
because it becomes paragraph content; fault two moves the fence boundary while
the content stays inside a code block, so nothing is escaped. That difference is
what the mutation harness measures, one fault at a time, and the escaping is
measured twice over: once as the anchor fault's shadow, and once at the
serialiser's escape flag, which produces it with no comment involved.

## The guarantee this violates

The byte-for-byte round trip is an existing promise of this project, not a
standard invented for this change. `CONTRIBUTING.md` states it for the editor
directory; `test/helpers/editor-harness.js` calls it the hard acceptance bar;
`test/unit/ofm-parity.test.js` enforces it over a fixture corpus where a
rendering gap is acceptable and corruption never is. The tests for this change
hook into those, in the same harness and against the same bar, rather than
asserting a fresh guarantee of their own.

## Fixture inventory

> **AC-10:** The existing review fixtures are inventoried for whether any
> contains a fence.
>
> **AC-11:** The count that do is reported in the evidence.

Fixture files on disk. The column counts **fence marker lines**, which is what
the pattern matches: a fence contributes two, its opening and its closing, so a
file showing 4 holds two fenced blocks. Counted with:

    for f in $(find test/fixtures -name "*.md" | sort); do
      echo "$(grep -cE '^ {0,3}(`{3,}|~{3,})' "$f") $f"
    done

| Fixture | Fence marker lines |
|---|---|
| `test/fixtures/kanban/backlog.md` | 2 |
| `test/fixtures/kanban/combined.md` | 2 |
| `test/fixtures/kanban/edge-cases.md` | 2 |
| `test/fixtures/kanban/roadmap.md` | 2 |
| `test/fixtures/markdown-benign.md` | 4 |
| `test/fixtures/ofm/block-references.md` | 0 |
| `test/fixtures/ofm/blockquotes.md` | 0 |
| `test/fixtures/ofm/callouts.md` | 0 |
| `test/fixtures/ofm/code-blocks.md` | 4 |
| `test/fixtures/ofm/comments.md` | 0 |
| `test/fixtures/ofm/embeds.md` | 0 |
| `test/fixtures/ofm/emphasis-extended.md` | 0 |
| `test/fixtures/ofm/escapes.md` | 0 |
| `test/fixtures/ofm/footnotes.md` | 0 |
| `test/fixtures/ofm/frontmatter-properties.md` | 0 |
| `test/fixtures/ofm/headings-and-text.md` | 0 |
| `test/fixtures/ofm/horizontal-rules.md` | 0 |
| `test/fixtures/ofm/inline-html.md` | 0 |
| `test/fixtures/ofm/line-breaks.md` | 0 |
| `test/fixtures/ofm/links-and-images.md` | 0 |
| `test/fixtures/ofm/lists.md` | 0 |
| `test/fixtures/ofm/maths.md` | 0 |
| `test/fixtures/ofm/mermaid.md` | 2 |
| `test/fixtures/ofm/tables.md` | 0 |
| `test/fixtures/ofm/tags.md` | 0 |
| `test/fixtures/ofm/wikilinks.md` | 0 |
| `test/fixtures/scoring-table.md` | 0 |

**27 markdown fixture files. 7 contain a fence. 0 were driven through the review
round trip before this change.** The headline is a count of files, so it does not
depend on how the markers per file are counted.

The count that explains why this shipped is the second one. The review suites
build their documents as strings in the test file and read no fixture from disk
at all. Counted with:

    grep -c '```\|~~~' test/unit/editor-review-roundtrip.test.js \
      test/unit/review-sectioned-roundtrip.test.js \
      test/unit/review-controller.test.js test/unit/criticmarkup.test.js \
      test/unit/sidecar-controller.test.js

Five lines across those five files mention a fence, and all five are in one
file. Four of them (`editor-review-roundtrip.test.js` lines 147, 154, 157, 160)
call `parseFile` to check that review-shaped YAML inside a fence is not mistaken
for the endmatter block; they never build an editor. The fifth (line 65) does
round-trip a fence through the editor, and asserts that CriticMarkup inside a
fence stays literal. It is a three-backtick fence with no marker-length
variation, and no review operation is applied to it.

**So: review operations applied to a document containing a fence, before this
change: 0. Fence-bearing documents round-tripped through the editor by the
review suites: 1, hand-built, three backticks.** Every test agreed the feature
worked, and none of them could have disagreed.

Of the four fixture families that do carry a fence, none reached the editor
either: the kanban files drive the board parser, and `markdown-benign.md` drives
the chat renderer. `test/fixtures/ofm/code-blocks.md` is the one fence fixture
the editor round trip does read, and its four marker lines are two blocks: a
plain three-backtick fence and a `js` fence, so fault two was invisible to it as
well.

## The new fixture is a file, not a string

> **AC-12:** A test drives a real fixture file containing a fence through the
> round trip, rather than a hand-built string.

`test/fixtures/review/fenced-page.md` is read from disk by
`test/unit/review-fenced-roundtrip.test.js`. It is a page about writing
markdown, which is the document that broke: prose with bold, code spans and
links; a three-backtick fence wrapping markdown; a four-backtick fence wrapping
a three-backtick fence; and a tilde fence.
`test/fixtures/ofm/code-blocks.md` gained the same marker variations, so the
parity corpus covers them too.

## Fence shapes

> **AC-6:** Four-backtick fences are handled, since a page about markdown
> contains them.
>
> **AC-7:** A fence nested inside a larger fence is handled.
>
> **AC-8:** A tilde fence is handled, or the diff records that the parser in use
> does not accept one and what it does instead.

The parser accepts all three. The four-backtick fence, the three-backtick fence
nested inside it, and the tilde fence are in the fixture and are asserted by
name in `test/unit/review-fenced-roundtrip.test.js`. The serialiser now records
the source marker character, its length and the full info string at parse time
and writes them back, and it widens the marker when the block's own content
would otherwise close it.

**One fence shape is still rewritten and is not fixed here, and disclosure is
not discharge, so it is pinned by a test rather than by this paragraph.** A
fence indented one to three spaces is dedented on save:

    in:  "  ```js\n  const nested = {\n    deep: true,\n  };\n  ```\n"
    out: "```js\nconst nested = {\n  deep: true,\n};\n```\n"

It is not fixable from the node. The parser strips up to the fence's own indent
from every content line, so a line indented LESS than its fence is afterwards
indistinguishable from one indented exactly to it, and re-emitting the fence's
indent on both would move bytes rather than restore them. Carrying the block's
raw source instead is a different design and a larger change than this one.

`test/fixtures/review/indented-fence.md` and the three tests in
`an indented fence: a known drift, not a fixed one` hold the gap to its exact
size, on the same idiom the parity corpus already uses for a carded corruption.
They assert that the output is the input with the fence indent removed and
nothing else, so the tests fail if the drift widens; that the block still opens
and closes where it did, its contents are still inside it, and nothing gained a
backslash; and that a second cycle changes nothing further, so the file does not
lose a level of indentation on every save. The first of them also fails if the
shape is ever fixed, which is what takes this note out of the file with it.

The drift moves no content across a fence boundary and escapes nothing, which is
what separates it from the two faults this change is about.

## Proving the prohibitions

> **AC-1:** Adding a comment to a file containing a fenced block leaves every
> byte outside the comment markers unchanged.
>
> **AC-2:** Editing a comment on such a file leaves every byte outside the
> comment markers unchanged.
>
> **AC-3:** Removing a comment restores the file to what it was before the
> comment was added, byte for byte.

These are prohibitions, and reverting the source cannot discharge one. Reverting
makes a test fail because the feature is gone, not because bytes were preserved,
so a red run proves nothing about the prohibition.

They are proved instead by committing the corruption. `test/tools/mutate-fence-guards.js`
puts each fault back into the source one at a time and requires a test to go red
for it, in the shape the other mutation harnesses in `test/tools/` already use.
It runs inside the pre-commit gate as part of `npm run mutate:guards`.

Run it with:

    node test/tools/mutate-fence-guards.js --markdown

Result, pasted from that run:

| Guard broken | Places found | Tests red | Which |
|---|---|---|---|
| a comment refuses a range in a block that holds only text | 1 | 6 | `a comment anchored inside a fence is refused, with a reason`<br>`a refused comment changes nothing, so it cannot half-apply`<br>`the block survives the refusal intact, fence markers and all`<br>`the composer stays open, shows the reason, and keeps what was typed`<br>`a success is the anchor id, nothing to do is false, a refusal names itself`<br>`the refusal reason names a code block only when a code block refused` |
| a suggested replacement refuses a range in a block that holds only text | 1 | 1 | `a suggested replacement inside a fence is refused the same way` |
| a suggested insertion refuses a cursor in a block that holds only text | 1 | 1 | `a suggested insertion at a cursor inside a fence is refused the same way` |
| the fence is the one the file was written with, not a fixed three backticks | 1 | 13 | `the fixture round-trips byte-for-byte`<br>`the four-backtick fence keeps four backticks, so its inner fence stays inside it`<br>`the tilde fence is still a tilde fence`<br>`a fence written into a block is longer than the fences the block now holds`<br>`a second and third cycle change nothing further`<br>`adding a comment in prose changes only the comment markers`<br>`replying to a comment leaves the document bytes alone`<br>`resolving a comment gives the document back its original bytes`<br>`a refused comment changes nothing, so it cannot half-apply`<br>`a suggested replacement inside a fence is refused the same way`<br>`a suggested insertion at a cursor inside a fence is refused the same way`<br>`the block survives the refusal intact, fence markers and all`<br>`the composer stays open, shows the reason, and keeps what was typed` |
| the fence keeps its marker character, so a tilde fence stays a tilde fence | 1 | 10 | `the fixture round-trips byte-for-byte`<br>`the tilde fence is still a tilde fence`<br>`a second and third cycle change nothing further`<br>`adding a comment in prose changes only the comment markers`<br>`replying to a comment leaves the document bytes alone`<br>`resolving a comment gives the document back its original bytes`<br>`a refused comment changes nothing, so it cannot half-apply`<br>`a suggested replacement inside a fence is refused the same way`<br>`a suggested insertion at a cursor inside a fence is refused the same way`<br>`the composer stays open, shows the reason, and keeps what was typed` |
| the fence is widened past any fence inside the block | 1 | 1 | `a fence written into a block is longer than the fences the block now holds` |
| the contents of a fenced block are written literally, not escaped as prose | 1 | 13 | `the fixture round-trips byte-for-byte`<br>`the four-backtick fence keeps four backticks, so its inner fence stays inside it`<br>`the markdown inside a fence is written back unescaped`<br>`a fence written into a block is longer than the fences the block now holds`<br>`a second and third cycle change nothing further`<br>`adding a comment in prose changes only the comment markers`<br>`replying to a comment leaves the document bytes alone`<br>`resolving a comment gives the document back its original bytes`<br>`a refused comment changes nothing, so it cannot half-apply`<br>`a suggested replacement inside a fence is refused the same way`<br>`a suggested insertion at a cursor inside a fence is refused the same way`<br>`the block survives the refusal intact, fence markers and all`<br>`the composer stays open, shows the reason, and keeps what was typed` |
| the whole info string is written back, not just the language word | 1 | 1 | `code-blocks.md round-trips byte-for-byte` |

Deliberately not mutated:

- **the escaping of text swept out of a block by the anchor fault:** that route has no line of its own to break. Once an atom has closed the block, the remainder is paragraph text, and escaping paragraph text is the serialiser doing the correct thing: there is no guard there to remove. It is reintroduced by the first three rows, whose tests assert on the backslashes as well as on the fence. The OTHER route to the same damage does have a line, and it is mutated: see the escape flag row above, which escapes a fenced block with no comment involved.
- **the panel showing the refusal reason in the composer:** it is display, and the byte-preservation claims do not rest on it. It has a test that drives the real sidebar and reads the rendered reason, which is the right instrument for it; a mutation here would report on that test twice.

### Which row carries which prohibition

Read the rows against the three criteria rather than as a single green block.

**The corruption is put back in both of its forms.** The report carried an early
fence close and an escaping, so evidence that covered only the first would be
evidence for half the criterion. The early close is rows one, four and five; the
escaping is row seven, the escape flag on the call that writes a block's
contents, which produces it with no comment anywhere near it.

**Adding a comment.** Under row one, the anchor fault,
`a refused comment changes nothing, so it cannot half-apply` goes red, and that
test compares the whole saved file against the fixture's bytes. Under rows four
and five, the fence marker dropped,
`adding a comment in prose changes only the comment markers` goes red: that test
strips the construct back to the words it wraps and requires what is left to be
the file that was opened. Under row seven, the escaping,
`the markdown inside a fence is written back unescaped` goes red naming the
symptom, and `adding a comment in prose changes only the comment markers` goes
red with it, because that test also refuses a backslash anywhere in the file.

**Editing a comment.** `replying to a comment leaves the document bytes alone`
goes red under rows four, five and seven, so both forms are covered here too. It
is not red under the first three, and that is not a gap: the anchor fault only
fires when the anchor is inside a fenced block, and a refused anchor leaves no
comment to reply to.

**Removing a comment.** `resolving a comment gives the document back its
original bytes` goes red under rows four, five and seven, on the same terms and
with the same exception.

Two limits travel with this table rather than being left for a reader to find.
A mutation proves a test objects to that specific corruption; it cannot prove
the test measures the right thing, so the assertions are byte comparisons
against a file read from disk rather than containment checks. And the review
block is excluded from those comparisons, because review data has to be stored
somewhere: what the tests hold fixed is the frontmatter, the body and the
trailing newline run, and the assertion that the record was written at all sits
beside each one so an operation that quietly did nothing cannot pass.

## Refusal

> **AC-4:** A comment anchored inside a fenced region either applies correctly
> or is refused with a stated reason.
>
> **AC-5:** A refused anchor changes nothing on disk, so it cannot half-apply.

A construct cannot be placed inside a fenced block correctly, because the block
holds text and nothing else, so the anchor is refused. The controller checks the
block's content expression before it does anything at all: before it allocates
an id, before it opens a transaction, and before it records anything in the
review data. It returns the refusal and its reason to the caller, and the review
sidebar keeps the composer open and shows the reason instead of closing it and
saving.

Nothing on disk changes. The test serialises the file before the refused
attempt and after it and compares the two strings, and asserts that the
controller never became dirty, so no save would have been triggered either.

**The reason is read off the block that refused, rather than assumed.** The
guard asks a block what it can hold, so it also fires where there is no block at
all, and a message that always said "a code block" would be naming a cause it
had not checked. A fenced block is named when it is the one refusing, and the
wording falls back otherwise.
`the refusal reason names a code block only when a code block refused` holds
both halves: it drives a refusal from inside a fence and reads the wording, then
drives one from a position between blocks and requires that a code block is not
blamed for it.

**The three authoring commands now have three outcomes where they had two**, and
that is the kind of change a later caller reads wrongly. A success is still the
anchor id as a string and nothing to do is still `false`; a refusal is
`{ refused: true, reason }`, which is truthy, so a caller testing the result for
truthiness has to check `refused` rather than read a refusal as success. The
contract is stated at the top of the controller and pinned by
`a success is the anchor id, nothing to do is false, a refusal names itself`,
which asserts all three shapes for all three commands. The only caller in the
tree is the review sidebar, and it is driven by a test of its own.
