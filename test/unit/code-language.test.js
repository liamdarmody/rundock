'use strict';
// Fenced code-block language resolution, against the REAL vendored
// highlight.js build (UMD, requireable in Node). Regression suite for the
// "plain text renders as Visual Basic .NET" bug: highlightAuto over the
// full language set lets VB.NET's prose-like grammar win on ordinary
// sentences. Unlabelled blocks now detect over a curated subset with a
// relevance gate; anything below the gate is escaped plaintext labelled
// "text".
const { test, describe } = require('node:test');
const assert = require('node:assert');

const hljs = require('../../public/vendor/highlight/highlight.min.js');
const resolveCodeLanguage = require('../../public/code-language.js');

describe('resolveCodeLanguage', () => {
  // The two blocks from the original report, structurally: plain prose and
  // a plain-text list, both of which the full-set highlightAuto labels vbnet.
  const PLAIN_SENTENCE = 'This is a plain sentence about nothing in particular, written as ordinary prose.';
  const PLAIN_LIST = 'Groceries for the week\n- Apples and pears\n- Two loaves of bread\n- Coffee beans\n- Washing up liquid';
  const LOG_LINES = '2026-07-14 10:00:01 INFO server started on port 3000\n2026-07-14 10:00:02 WARN retry scheduled\n2026-07-14 10:00:05 INFO client connected';

  test('regression: plain prose and plain lists resolve to text, never vbnet', () => {
    for (const text of [PLAIN_SENTENCE, PLAIN_LIST, LOG_LINES]) {
      const r = resolveCodeLanguage(undefined, text, hljs);
      assert.strictEqual(r.label, 'text', `label for: ${text.slice(0, 30)}`);
      assert.ok(!r.html.includes('<span'), 'plaintext is escaped, not highlighted');
    }
    // Pin the bug itself: the full-set auto-detect really does say vbnet,
    // so this suite fails loudly if the curated-subset gate is removed.
    const full = hljs.highlightAuto(PLAIN_SENTENCE);
    assert.strictEqual(full.language, 'vbnet', 'the underlying misdetection still exists upstream');
  });

  test('a markdown block resolves to markdown', () => {
    const md = '# Heading\n\nSome **bold** text and a [link](https://example.com).\n\n- item one\n- item two\n\n```\ninner fence\n```';
    const r = resolveCodeLanguage(undefined, md, hljs);
    assert.strictEqual(r.label, 'Markdown');
  });

  test('real json and shell also clear the gate (threshold tuned at 5 against the corpus)', () => {
    const json = '{\n  "name": "example",\n  "items": [1, 2, 3],\n  "nested": { "ok": true }\n}';
    const sh = 'for f in *.md; do\n  grep -l "TODO" "$f" && echo "$f needs work"\ndone';
    assert.strictEqual(resolveCodeLanguage(undefined, json, hljs).label, 'JSON');
    assert.strictEqual(resolveCodeLanguage(undefined, sh, hljs).label, 'Bash');
  });

  test('real code still auto-detects: javascript and python clear the gate', () => {
    const js = "const items = rows.filter(r => r.active).map(r => r.id);\nfunction total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { total };";
    const py = "def total(xs):\n    return sum(x.value for x in xs if x.active)\n\nimport json\nwith open('data.json') as f:\n    data = json.load(f)\nprint(total(data))";
    assert.strictEqual(resolveCodeLanguage(undefined, js, hljs).label, 'JavaScript');
    assert.strictEqual(resolveCodeLanguage(undefined, py, hljs).label, 'Python');
  });

  // A long plain-text draft (e.g. a LinkedIn post) rendered in a bare fence.
  // highlight.js relevance ACCUMULATES with length, so a long prose block piles
  // up incidental matches and clears the flat relevance floor (tuned on short
  // fixtures) while remaining obvious prose. A relevance-density gate catches
  // it: prose stays low-density however long it runs; real code is dense.
  const LONG_PROSE = [
    'I spent three years building products nobody asked for.',
    'Then I changed one habit and everything shifted.',
    "Here's the habit: every Monday, I write down the single most important decision my team faces that week.",
    'Not a task. Not a feature. A decision.',
    "Because here's what I learned running product at two startups:",
    "Teams don't fail because they can't build. They fail because they build the wrong thing, confidently, for months.",
    'The best product leaders I know are ruthless about one question: what has to be true for this to work?',
    "If you can't answer that, you're not ready to build. You're ready to guess.",
    'Write the decision. Write what has to be true. Then go find out if it is.',
    'What decision is your team avoiding right now?',
  ].join('\n');

  test('regression: a long plain-text draft resolves to text, not a code language', () => {
    const r = resolveCodeLanguage(undefined, LONG_PROSE, hljs);
    assert.strictEqual(r.label, 'text', 'long prose renders as text, not Rust');
    assert.ok(!r.html.includes('<span'), 'long prose is escaped, not highlighted');
    // Pin the mechanism: the block DOES clear the flat relevance floor, so this
    // fails loudly if the density gate is removed and only the floor remains.
    const subset = resolveCodeLanguage.AUTODETECT_SUBSET.filter(l => hljs.getLanguage(l));
    const auto = hljs.highlightAuto(LONG_PROSE, subset);
    assert.ok(auto.relevance >= resolveCodeLanguage.AUTODETECT_RELEVANCE_MIN,
      `underlying auto-detect clears the flat floor (rel=${auto.relevance}), so only the density gate rejects it`);
  });

  test('a long, indented real code block still auto-detects (density gate keeps genuine code)', () => {
    const py = [
      'class Widget:',
      '    def __init__(self, name):',
      '        self.name = name',
      '        self.children = []',
      '',
      '    def add(self, child):',
      '        if child is not None:',
      '            self.children.append(child)',
      '            return True',
      '        return False',
    ].join('\n');
    assert.strictEqual(resolveCodeLanguage(undefined, py, hljs).label, 'Python');
  });

  test('an explicit hint always wins, including vbnet', () => {
    const r = resolveCodeLanguage('vbnet', 'Dim x As Integer = 4', hljs);
    assert.strictEqual(r.label, 'Visual Basic .NET');
    assert.ok(r.html.includes('<span'), 'explicitly hinted code is highlighted');
  });

  test('explicit plain-text hints are first-class: escaped, labelled text', () => {
    for (const hint of ['text', 'plaintext', 'plain', 'TXT']) {
      const r = resolveCodeLanguage(hint, '<b>not markup</b> just text', hljs);
      assert.strictEqual(r.label, 'text', `hint: ${hint}`);
      assert.strictEqual(r.html, '&lt;b&gt;not markup&lt;/b&gt; just text');
    }
  });

  test('unknown hints render escaped with the hint as label (unchanged behaviour)', () => {
    const r = resolveCodeLanguage('made-up-lang', 'whatever <content>', hljs);
    assert.strictEqual(r.label, 'made-up-lang');
    assert.strictEqual(r.html, 'whatever &lt;content&gt;');
  });

  test('oversized blocks skip auto-detection and render escaped', () => {
    const big = 'x <tag> '.repeat(4000); // 32k chars
    const r = resolveCodeLanguage(undefined, big, hljs, 20000);
    assert.strictEqual(r.label, '');
    assert.ok(r.html.includes('&lt;tag&gt;'));
  });

  test('absent hljs degrades to escaped plaintext without throwing', () => {
    const r = resolveCodeLanguage('javascript', 'const a = 1 < 2;', undefined);
    assert.strictEqual(r.html, 'const a = 1 &lt; 2;');
    assert.strictEqual(r.label, 'javascript');
  });

  test('the curated subset never contains prose-greedy grammars', () => {
    assert.ok(!resolveCodeLanguage.AUTODETECT_SUBSET.includes('vbnet'));
    assert.ok(resolveCodeLanguage.AUTODETECT_SUBSET.includes('markdown'));
  });
});
