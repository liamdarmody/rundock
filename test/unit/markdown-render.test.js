'use strict';
// The renderer's behaviour contract: ordinary markdown renders as it always
// did, and hostile markdown cannot become script.
//
// Everything here drives renderMarkdown itself, not a unit of the parser. The
// defects this suite exists for all live in the pre- and post-processing
// wrapped around marked, so a test that called marked directly would exercise
// none of them.
//
// AC-9, AC-11 and AC-15 are the half that matters most day to day: the likeliest
// way to fail this card is to break ordinary markdown while closing the hole.
// formatMd has nine call sites across chat and message handling, so a
// regression here is visible in every conversation in the app.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { makeRenderer, attachWikilinkHandler, attachCodeCopyHandler } = require('../helpers/markdown-harness.js');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const BENIGN_MD = fs.readFileSync(path.join(FIXTURES, 'markdown-benign.md'), 'utf8');
// What this renderer produces now. Regenerated only by a commit that means to
// change rendering, and never without the invariant below still holding.
const BENIGN_HTML = fs.readFileSync(path.join(FIXTURES, 'markdown-benign.html'), 'utf8');
// What the renderer produced on main BEFORE this card, generated from the code
// in public/app.js as it stood. Frozen: nothing on this branch may regenerate
// it, because it is the only record of what "unchanged" means.
const BENIGN_BEFORE = fs.readFileSync(path.join(FIXTURES, 'markdown-benign-before.html'), 'utf8');

const { renderMarkdown } = makeRenderer();
const render = (src) => renderMarkdown(src, { callouts: true });

// The shape of a rendered document: every element, its class, and its own
// text, exactly.
//
// This is the invariant that must hold across every commit on this card. The
// byte fixture is stricter and legitimately moves, because this card turns two
// inline handlers into listeners and drops the blank line the old callout box
// left behind it. This does not move. If the escaping work ever swallows an
// element, changes a class, or alters a single character INSIDE one, it fails,
// and regenerating the byte fixture cannot hide it.
//
// Text is compared per element rather than as one string for the whole
// document, so whitespace BETWEEN block elements is out of scope while
// whitespace inside them, which is the whole content of a <pre>, is compared
// exactly. The container's own text nodes are the only thing skipped, and at
// the top level of marked's output those are the inter-block newlines.
function outline(html) {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const ownText = (el) => Array.from(el.childNodes)
    .filter((node) => node.nodeType === 3)
    .map((node) => node.data)
    .join('');
  const walk = (el) => Array.from(el.children).map((child) => ({
    tag: child.tagName.toLowerCase(),
    cls: child.getAttribute('class') || '',
    text: ownText(child),
    children: walk(child),
  }));
  return walk(dom.window.document.getElementById('root'));
}

describe('renderMarkdown: ordinary markdown is untouched by this card', () => {
  test('AC-15: the benign document renders to the recorded bytes', () => {
    assert.strictEqual(render(BENIGN_MD), BENIGN_HTML);
  });

  test('AC-15: the benign document keeps the structure and text it had before this card', () => {
    assert.deepStrictEqual(outline(render(BENIGN_MD)), outline(BENIGN_BEFORE));
  });

  test('AC-9: code blocks, tables, task lists and callouts still render', () => {
    const doc = new JSDOM(`<div id="root">${render(BENIGN_MD)}</div>`).window.document;
    assert.strictEqual(doc.querySelectorAll('.code-block-wrapper pre code.hljs').length, 2, 'both fenced blocks');
    assert.ok(doc.querySelector('.md-table-wrap > table > thead'), 'table wrapped and intact');
    assert.strictEqual(doc.querySelectorAll('input[type="checkbox"]').length, 2, 'both task list items');
    assert.strictEqual(doc.querySelectorAll('input[checked]').length, 1, 'the ticked one stays ticked');
    const callout = doc.querySelector('.callout.callout-note');
    assert.ok(callout, 'callout box');
    assert.strictEqual(callout.querySelector('.callout-title').textContent, 'Plain title');
    assert.ok(callout.querySelector('.callout-content strong'), 'callout body is still parsed as markdown');
  });

  test('AC-11: highlighting still applies to fenced code', () => {
    const doc = new JSDOM(`<div id="root">${render(BENIGN_MD)}</div>`).window.document;
    const js = doc.querySelector('.code-block-wrapper');
    assert.strictEqual(js.querySelector('.code-lang').textContent, 'JavaScript');
    assert.ok(js.querySelector('code.hljs .hljs-keyword'), 'hljs token spans are present');
  });
});

// ---------------------------------------------------------------------------
// Injection point 3: wikilink source rewriting.
//
// Before this card, renderMarkdown replaced [[target|label]] in the SOURCE with
//   <a class="wikilink" onclick="openWikilink('$1')">$2</a>
// and took both captures verbatim. `$1` lands inside a single-quoted JavaScript
// string inside a double-quoted HTML attribute, so a quote in the target ends
// the string and everything after it is code the page runs on click; a quote
// plus a space opens a NEW attribute, and onmouseover does not even need the
// click. Recorded payloads, run against the pre-card renderer:
//   [[note' onmouseover='alert(1)]]
//     -> onclick="openWikilink('note' onmouseover='alert(1)')"
//   [[a') + alert(1) + ('b]]
//     -> onclick="openWikilink('a') + alert(1) + ('b')"
// ---------------------------------------------------------------------------
describe('renderMarkdown: wikilink targets cannot reach the handler as code', () => {
  const attrs = (html) => {
    const doc = new JSDOM(`<div id="root">${html}</div>`).window.document;
    return Array.from(doc.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes).map((a) => a.name));
  };

  test('AC-4: a quote in the target cannot open a second attribute', () => {
    // Both quote characters, because the target now travels in a double-quoted
    // attribute and only the double quote can end that one. The single-quote
    // payload is the one the old inline handler fell to and is kept as the
    // record of it.
    for (const src of ["[[note' onmouseover='alert(1)]]", '[[note" onmouseover="alert(1)]]']) {
      const html = render(src);
      assert.ok(!attrs(html).some((name) => name.startsWith('on')), `handler attribute survived: ${html}`);
    }
  });

  test('AC-4: a target that closes the call cannot append an expression', () => {
    const html = render("[[a') + alert(1) + ('b]]");
    assert.ok(!/alert\(1\)/.test(html.replace(/&#\d+;/g, '')) || !attrs(html).some((n) => n.startsWith('on')),
      `payload reached an executable position: ${html}`);
    assert.ok(!attrs(html).some((name) => name.startsWith('on')), `handler attribute survived: ${html}`);
  });

  test('AC-2: no wikilink render carries an event-handler attribute', () => {
    for (const src of ['[[Plain]]', '[[Target|Label]]', "[[a'b]]", '[[a"b]]', '[[a\\b]]']) {
      assert.ok(!attrs(render(src)).some((name) => name.startsWith('on')), `handler attribute in: ${src}`);
    }
  });

  test('AC-10: a click still reaches openWikilink with the same target value', () => {
    // The target values the old onclick would have passed, for targets that did
    // not break it. The listener must deliver these characters unchanged.
    const targets = ['Plain note', 'folder/Note', "Bobby's note", 'a"b', 'a\\b', "note' onmouseover='alert(1)"];
    for (const target of targets) {
      const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
      const doc = dom.window.document;
      doc.getElementById('root').innerHTML = render(`[[${target}]]`);
      const seen = [];
      attachWikilinkHandler(doc, (value) => seen.push(value));
      const anchor = doc.querySelector('a.wikilink');
      assert.ok(anchor, `no anchor for target: ${target}`);
      anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.deepStrictEqual(seen, [target]);
    }
  });

  test('AC-10: the visible label is still the alias, or the target when there is none', () => {
    const doc = (html) => new JSDOM(`<div id="root">${html}</div>`).window.document;
    assert.strictEqual(doc(render('[[Target|Label]]')).querySelector('a.wikilink').textContent, 'Label');
    assert.strictEqual(doc(render('[[Target]]')).querySelector('a.wikilink').textContent, 'Target');
    assert.ok(doc(render('[[Target|**bold**]]')).querySelector('a.wikilink strong'), 'alias is still parsed as markdown');
  });

  test('a wikilink inside code is left alone, which the source rewrite could not do', () => {
    // Recorded change of behaviour, not a regression. The old pass ran a
    // regex over the whole source, so `[[a]]` inside a code span became the
    // literal text of an anchor tag. A tokenizer never enters a code span.
    const html = render('`[[a]]`');
    assert.ok(/<code>\[\[a\]\]<\/code>/.test(html), html);
  });
});

// ---------------------------------------------------------------------------
// Injection point 2: callout titles.
//
// processCalloutsSrc built its box by string concatenation BEFORE any parser
// ran: `<div class="callout-title">${title}</div>`, where title is the raw
// remainder of the `> [!type]` line. marked was never involved, so nothing
// about the parser's own escaping applied. Recorded payload, run against the
// pre-card renderer:
//   > [!note] <img src=x onerror=alert(1)>
//     -> <div class="callout-title"><img src=x onerror=alert(1)></div>
// which is an image element in the DOM with an onerror handler, and needs no
// interaction at all: a broken src fires it on render.
// ---------------------------------------------------------------------------
describe('renderMarkdown: a callout title is text, not markup', () => {
  const doc = (html) => new JSDOM(`<div id="root">${html}</div>`).window.document;

  test('AC-3: a title containing a tag renders as text', () => {
    const d = doc(render('> [!note] <img src=x onerror=alert(1)>\n> body\n'));
    assert.strictEqual(d.querySelectorAll('img').length, 0, 'no element was created from the title');
    assert.strictEqual(d.querySelector('.callout-title').textContent, '<img src=x onerror=alert(1)>');
  });

  test('AC-3: a title cannot close the box it is written into', () => {
    const d = doc(render('> [!note] </div><a href="#" onclick="alert(1)">x</a><div>\n> body\n'));
    assert.strictEqual(d.querySelectorAll('a').length, 0);
    assert.strictEqual(d.querySelectorAll('.callout-title').length, 1);
    assert.ok(d.querySelector('.callout-content'), 'the box still has its content div');
  });

  test('AC-2: no callout render carries an event-handler attribute', () => {
    for (const src of [
      '> [!note] <img src=x onerror=alert(1)>\n> body\n',
      '> [!tip] " onmouseover="alert(1)\n> body\n',
    ]) {
      const d = doc(render(src));
      const names = Array.from(d.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes).map((a) => a.name));
      assert.ok(!names.some((n) => n.startsWith('on')), `handler attribute in: ${src}`);
    }
  });

  test('the callout type still becomes the modifier class', () => {
    const d = doc(render('> [!Warning] Careful\n> body\n'));
    assert.ok(d.querySelector('.callout.callout-warning'), 'type is lowercased into the class');
  });
});

// ---------------------------------------------------------------------------
// Injection point 4: relative-link rewriting.
//
// A link whose href ended in .md/.yaml/.yml/.json/.txt was rewritten, AFTER
// marked had produced HTML, into an inline handler:
//   `onclick="openWikilink('${href.replace(/'/g, "\\'")}')"`
// The escaping is a JavaScript rule applied to a value going into an HTML
// attribute, and an HTML attribute is not a JavaScript string until the browser
// has finished parsing it: character references are decoded FIRST, and the
// replace never sees them. Recorded payload, run against the pre-card renderer:
//   [a](<&#39;&#41;;alert&#40;1&#41;;//.md>)
//     -> onclick="openWikilink('&#39;&#41;;alert&#40;1&#41;;//.md')"
// which the parser decodes to
//        openWikilink('');alert(1);//.md')
// and the page runs alert(1) on click. Backslashes cannot do it, because marked
// percent-encodes them in an href; character references walk straight past.
// ---------------------------------------------------------------------------
describe('renderMarkdown: a relative link cannot rewrite its own handler', () => {
  const handlerAttrs = (html) => {
    const d = new JSDOM(`<div id="root">${html}</div>`).window.document;
    return Array.from(d.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes))
      .filter((a) => a.name.startsWith('on'));
  };

  test('AC-5: character references in a filename cannot become code', () => {
    const html = render('[a](<&#39;&#41;;alert&#40;1&#41;;//.md>)');
    assert.deepStrictEqual(handlerAttrs(html).map((a) => a.name), [], html);
  });

  test('AC-5: a quote or a backslash in a filename cannot alter the handler', () => {
    for (const src of ["[a](<x'.md>)", '[a](<x\\\\.md>)', '[a](<x\\\\\');alert(1);//.md>)']) {
      assert.deepStrictEqual(handlerAttrs(render(src)).map((a) => a.name), [], src);
    }
  });

  test('AC-10: a relative link still opens the same target', () => {
    // The values the old rewrite passed to openWikilink, for the hrefs it
    // handled. Left column is the markdown; right is what must still arrive.
    const cases = [['[a](notes/Plan.md)', 'notes/Plan.md'], ['[a](config.yaml)', 'config.yaml'],
      ['[a](data.json)', 'data.json'], ['[a](log.txt)', 'log.txt'], ['[a](a%20b.md)', 'a%20b.md']];
    for (const [src, expected] of cases) {
      const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
      const doc = dom.window.document;
      doc.getElementById('root').innerHTML = render(src);
      const seen = [];
      attachWikilinkHandler(doc, (value) => seen.push(value));
      const anchor = doc.querySelector('a.wikilink');
      assert.ok(anchor, `no wikilink anchor for: ${src}`);
      anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.deepStrictEqual(seen, [expected], src);
    }
  });

  test('AC-5: a character reference in a filename stays those characters', () => {
    // The guard against the payload above, seen from the benign side. A
    // destination is written into the attribute escaped as an attribute value,
    // so what the browser decodes back is what the document said, not one
    // decoding further on. Without that, `&#39;` would arrive as a quote, which
    // is exactly how the old rewrite was broken.
    for (const [src, expected] of [['[x](<&#39;.md>)', '&#39;.md'], ['[x](<a&amp;b.md>)', 'a&amp;b.md']]) {
      const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
      const doc = dom.window.document;
      doc.getElementById('root').innerHTML = render(src);
      const seen = [];
      attachWikilinkHandler(doc, (value) => seen.push(value));
      doc.querySelector('a.wikilink').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.deepStrictEqual(seen, [expected], src);
    }
  });

  test('links the rewrite never claimed are still ordinary links', () => {
    for (const [src, href] of [['[a](https://example.com/x.md)', 'https://example.com/x.md'],
      ['[a](mailto:x@example.com)', 'mailto:x@example.com'], ['[a](page.html)', 'page.html']]) {
      const d = new JSDOM(`<div id="root">${render(src)}</div>`).window.document;
      const anchor = d.querySelector('a');
      assert.strictEqual(anchor.getAttribute('href'), href, src);
      assert.strictEqual(anchor.getAttribute('class'), null, src);
    }
  });
});

// ---------------------------------------------------------------------------
// Highlights and tags: the last two source rewrites.
//
// `==text==` and `#tag` were regexes over the whole document that spliced
// <mark> and <span class="md-tag"> into the markdown. They are not an injection
// point on their own, but they are why the raw-HTML decision could not be made:
// once agent HTML stops being trusted, HTML the renderer wrote into the source
// is indistinguishable from HTML the document's author wrote there. Both are
// tokenizers now, which also fixes what a whole-document regex could never get
// right.
// ---------------------------------------------------------------------------
describe('renderMarkdown: highlights and tags stay out of code', () => {
  const doc = (html) => new JSDOM(`<div id="root">${html}</div>`).window.document;

  test('a fenced block containing #tag or ==text== keeps its own text', () => {
    // Before: the regexes ran inside the fence, so the block rendered visible
    // span and mark tags, and highlight.js then detected the block as HTML.
    const code = doc(render('```\nlet a = 1; // #todo and ==x==\n```\n')).querySelector('pre code');
    assert.strictEqual(code.textContent, 'let a = 1; // #todo and ==x==');
    assert.strictEqual(code.querySelectorAll('.md-tag, mark').length, 0);
  });

  test('a tag at the start of a line no longer swallows the line break', () => {
    // Before: the pattern consumed the preceding whitespace, newline included,
    // and put a single space back, so the two lines ran together.
    const d = doc(render('line one\n#tag next\n'));
    assert.ok(d.querySelector('br'), 'the line break survives');
    assert.strictEqual(d.querySelector('.md-tag').textContent, '#tag');
  });

  test('the ordinary forms render exactly as they did', () => {
    assert.strictEqual(render('a #tag b'), '<p>a <span class="md-tag">#tag</span> b</p>\n');
    assert.strictEqual(render('a ==hi== b'), '<p>a <mark>hi</mark> b</p>\n');
    assert.strictEqual(render('a==b==c'), '<p>a<mark>b</mark>c</p>\n');
    assert.strictEqual(render('C#programming is fine'), '<p>C#programming is fine</p>\n');
    assert.strictEqual(render('x `#tag` y'), '<p>x <code>#tag</code> y</p>\n');
  });
});

// ---------------------------------------------------------------------------
// Injection point 1: raw HTML reaching innerHTML.
//
// marked passes HTML through by design in its current major, and this renderer
// assigns the result to innerHTML with nothing in between. Recorded payloads,
// run against the pre-card renderer:
//   <img src=x onerror=alert(1)>   -> the same bytes, verbatim, into the DOM
//   Text <script>alert(1)</script> -> the same bytes, verbatim, into the DOM
// The script element is inert when set through innerHTML, which is a property
// of that one tag and not a defence; the image handler fires on render, with no
// interaction at all.
//
// And a FIFTH point, named by neither the card nor the criteria, found while
// closing this one: marked applies no scheme filter to a link destination.
//   [click](javascript:alert(1)) -> <a href="javascript:alert(1)">click</a>
// which runs on click. Same class, same renderer, same release.
// ---------------------------------------------------------------------------
describe('renderMarkdown: markdown cannot carry HTML into the page', () => {
  // Query from #root, never from the document: the wrapper is a div, and
  // counting it would report every payload as having produced one.
  const doc = (html) => new JSDOM(`<div id="root">${html}</div>`, { url: 'http://localhost/' })
    .window.document.getElementById('root');
  const handlerNames = (root) => Array.from(root.querySelectorAll('*'))
    .flatMap((el) => Array.from(el.attributes).map((a) => a.name)).filter((n) => n.startsWith('on'));

  test('AC-1, AC-2: a tag written in the document becomes text, not an element', () => {
    const payloads = [
      ['<img src=x onerror=alert(1)>', 'img'],
      ['Text <script>alert(1)</script> more', 'script'],
      ['<div onmouseover="alert(1)">hover</div>', 'div'],
      ['<svg onload="alert(1)"></svg>', 'svg'],
      ['<iframe src="javascript:alert(1)"></iframe>', 'iframe'],
      ['<a href="javascript:alert(1)">x</a>', 'a'],
      ['<style>*{x:y}</style>', 'style'],
      ['> [!note] fine\n> <img src=x onerror=alert(1)>\n', 'img'],
      ['| a |\n| --- |\n| <img src=x onerror=alert(1)> |\n', 'img'],
      ['- <img src=x onerror=alert(1)>\n', 'img'],
      ['[[Note|<img src=x onerror=alert(1)>]]', 'img'],
    ];
    for (const [src, tag] of payloads) {
      const d = doc(render(src));
      assert.strictEqual(d.querySelectorAll(tag).length, 0, `${tag} element created by: ${src}`);
      assert.deepStrictEqual(handlerNames(d), [], `handler attribute created by: ${src}`);
    }
  });

  test('AC-1: the escaped tag is still legible to the reader', () => {
    assert.match(doc(render('<img src=x onerror=alert(1)>')).textContent, /<img src=x onerror=alert\(1\)>/);
  });

  test('AC-1: a script scheme cannot reach an href or a src', () => {
    for (const src of ['[click](javascript:alert(1))', '[click](JaVaScRiPt:alert(1))',
      '[x](vbscript:msgbox)', '[x](data:text/html;base64,PHN2Zz4=)',
      '![x](javascript:alert(1))', '[x](java&Tab;script:alert(1))', '[x](&#106;avascript:alert(1))']) {
      // The RESOLVED url, which is what the browser would act on: a relative
      // href against the page's origin comes back as http:, and only a
      // destination that really carries a scheme keeps one of its own.
      for (const el of doc(render(src)).querySelectorAll('a[href], img[src]')) {
        const resolved = new URL(el.href || el.src, 'http://localhost/');
        assert.ok(['http:', 'https:', 'mailto:'].includes(resolved.protocol),
          `${resolved.protocol} survived in ${el.outerHTML} from: ${src}`);
      }
    }
  });

  test('the link text of a blocked destination is still shown', () => {
    assert.match(doc(render('[click me](javascript:alert(1))')).textContent, /click me/);
  });

  test('an HTML comment stays invisible instead of becoming visible text', () => {
    // Not decoration: the streaming path renders the raw response text, which
    // carries Rundock's own <!-- RUNDOCK:... --> markers. Escaping a comment
    // would have printed those markers into the conversation.
    assert.strictEqual(render('<!-- RUNDOCK:COMPLETE -->'), '');
    assert.strictEqual(doc(render('a <!-- x --> b')).textContent.trim(), 'a  b');
  });
});

// ---------------------------------------------------------------------------
// The other inline handler this renderer wrote. Not an injection point: the
// attribute is a constant and nothing from the document reaches it. It is here
// because a Content-Security-Policy worth having forbids inline handlers, and
// every one that survives is one more reason a policy cannot be turned on.
// ---------------------------------------------------------------------------
describe('renderMarkdown: the copy button is a listener, not an attribute', () => {
  const mount = (html) => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
    dom.window.document.getElementById('root').innerHTML = html;
    return dom;
  };

  test('AC-2: a rendered code block carries no event-handler attribute', () => {
    const dom = mount(render('```js\nconst x = 1;\n```\n'));
    const names = Array.from(dom.window.document.querySelectorAll('*'))
      .flatMap((el) => Array.from(el.attributes).map((a) => a.name));
    assert.ok(!names.some((n) => n.startsWith('on')), render('```js\nconst x = 1;\n```\n'));
  });

  test('clicking the button still copies the code block text', () => {
    const dom = mount(render('```js\nconst x = 1;\nconsole.log(x);\n```\n'));
    const copied = [];
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text) => { copied.push(text); return Promise.resolve(); } },
    });
    attachCodeCopyHandler(dom.window.document);
    const button = dom.window.document.querySelector('.copy-code-btn');
    assert.ok(button, 'the button is rendered');
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepStrictEqual(copied, ['const x = 1;\nconsole.log(x);']);
  });
});
