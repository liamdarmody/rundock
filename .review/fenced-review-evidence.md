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

The escaping follows from it and is not a separate defect. Once the remainder of
the block is paragraph text, it is prose, and the markdown serialiser escapes
prose that would otherwise re-parse as markup. The asterisks, backticks and
brackets that were code one step earlier are now literal characters in a
paragraph, so they are written back as `\*\*`, `` \` `` and `\[`. The serialiser
is doing the correct thing to the wrong content.

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
what the mutation harness measures, one fault at a time.

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

Fixture files on disk, counted with:

    for f in $(find test/fixtures -name "*.md" | sort); do
      echo "$(grep -cE '^ {0,3}(`{3,}|~{3,})' "$f") $f"
    done

| Fixture | Fence opening lines |
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
round trip before this change.**

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
the editor round trip does read, and it held only a plain three-backtick fence
and a `js` fence, so fault two was invisible to it as well.
