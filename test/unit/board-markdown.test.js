'use strict';
// Card display rendering: styled markdown with strict escaping. Card text is
// untrusted, so the priority is that no input can inject markup or a dangerous
// URL scheme.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderCardHtml } from '../../public/viewers/board-markdown.js';

describe('renderCardHtml', () => {
  test('escapes HTML so card text cannot inject markup', () => {
    const html = renderCardHtml('<img src=x onerror="alert(1)"> hi');
    assert.ok(!html.includes('<img'), 'raw tag must be escaped to inert text');
    assert.ok(html.includes('&lt;img'), 'angle brackets escaped');
    assert.ok(!html.includes('onerror="'), 'the handler quotes are escaped, so it can never fire');
  });

  test('renders bold, italic, strikethrough, and inline code', () => {
    assert.ok(renderCardHtml('**bold**').includes('<strong>bold</strong>'));
    assert.ok(renderCardHtml('_it_').includes('<em>it</em>'));
    assert.ok(renderCardHtml('~~gone~~').includes('<del>gone</del>'));
    assert.ok(renderCardHtml('`x=1`').includes('<code>x=1</code>'));
  });

  test('inline code content is not re-parsed as emphasis', () => {
    const html = renderCardHtml('`a*b*c`');
    assert.ok(html.includes('<code>a*b*c</code>'), 'code stays literal');
    assert.ok(!html.includes('<em>'), 'no emphasis inside code');
  });

  test('a number surrounded by spaces is not mistaken for a code placeholder', () => {
    const html = renderCardHtml('step 3 of 5');
    assert.ok(html.includes('step 3 of 5'), 'plain digits survive verbatim');
    assert.ok(!html.includes('undefined'), 'no placeholder collision');
  });

  test('safe links render; javascript: and data: URLs do not become hrefs', () => {
    assert.ok(renderCardHtml('[docs](https://example.com)').includes('<a href="https://example.com"'));
    const bad = renderCardHtml('[x](javascript:alert(1))');
    assert.ok(!bad.includes('href'), 'javascript: URL is not linked');
    const data = renderCardHtml('[y](data:text/html,<script>1</script>)');
    assert.ok(!data.includes('href'), 'data: URL is not linked');
  });

  test('wikilinks render as links, alias shown when present', () => {
    const a = renderCardHtml('[[Some Note]]');
    assert.ok(a.includes('class="board-wikilink"') && a.includes('data-target="Some Note"'));
    assert.ok(a.includes('>Some Note</a>'));
    const b = renderCardHtml('[[Some Note|Alias]]');
    assert.ok(b.includes('data-target="Some Note"') && b.includes('>Alias</a>'));
  });

  test('a wikilink target with a quote cannot break out of the attribute', () => {
    const html = renderCardHtml('[[x" onmouseover="pwn()]]');
    assert.ok(!/onmouseover="pwn/.test(html), 'the injected handler is neutralised by escaping');
  });

  test('multi-line card text joins with line breaks', () => {
    assert.ok(renderCardHtml('line one\nline two').includes('line one<br>line two'));
  });
});
