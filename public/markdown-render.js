'use strict';
// Rundock's markdown renderer: the single path from agent or file text to the
// HTML that goes into innerHTML.
//
// WHY THIS IS A MODULE. It lived inline in app.js, which cannot be loaded
// outside a browser: the file touches `document` at top level. That meant the
// renderer could only ever be tested through a unit of the parser or through a
// browser run, and neither exercises the pre- and post-processing wrapped
// around marked, which is where this renderer does most of its work and where
// its defects have been. Extracted here on the same pattern as
// code-language.js and chat-markup.js: UMD, no top-level DOM, requireable in
// node --test.
//
// The factory takes its dependencies rather than reading globals so a test can
// hand it the same marked build the browser gets (lib/http-router.js serves
// node_modules/marked/lib/marked.umd.js at /marked.min.js) and get the same
// bytes back.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockMarkdown = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // Escape for HTML TEXT position: the three characters that can start markup
  // or an entity. app.js does this with textContent/innerHTML round-tripping,
  // which needs a document; this is the same result without one.
  //
  // Note what it does NOT do: quotes are untouched, so this is not safe for an
  // attribute value. escapeAttr below is the one for that position.
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Escape for HTML ATTRIBUTE position. Both quote characters are included, so
  // the value cannot end the attribute whichever delimiter is used, and `<`
  // and `>` are included so a value cannot start a tag if the surrounding
  // markup is ever restructured.
  //
  // This is the ONLY escaping applied to a value that ends up in an attribute.
  // The renderer used to write attacker text into an inline handler and escape
  // it with a JavaScript rule (backslashes before quotes), which is the wrong
  // language for the position: the browser finishes parsing the attribute, and
  // decodes its character references, before any of it is JavaScript. Values
  // now go into data-* attributes read back through the DOM, so there is no
  // JavaScript position left to escape for.
  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  const HLJS_AUTODETECT_MAX = 20000; // skip highlightAuto on very large blocks (perf)

  const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  /**
   * Build a renderer bound to one marked instance.
   *
   * A dedicated `new marked.Marked(...)` rather than configuring the shared
   * `marked` namespace: the options and the renderer overrides below belong to
   * this renderer, and nothing else in the client should inherit them by having
   * loaded this file.
   *
   * @param {object} deps
   * @param {any} deps.marked                 the marked namespace (needs .Marked)
   * @param {any} [deps.hljs]                 vendored highlight.js build
   * @param {Function} [deps.resolveCodeLanguage] from code-language.js
   * @param {Function} [deps.emptyOrderedListText] from empty-list.js
   */
  function createMarkdownRenderer(deps) {
    const markedNs = deps.marked;
    const hljs = deps.hljs;
    const resolveCodeLanguage = deps.resolveCodeLanguage;
    const emptyOrderedListText = deps.emptyOrderedListText;

    const instance = new markedNs.Marked({ gfm: true, breaks: true });

    // Syntax-highlight fenced code blocks (highlight.js, vendored locally) and
    // wrap them with a header bar showing the language label and a copy button.
    // Originating contributions: copy button (#6/#7) and syntax highlighting
    // (#10/#11) by @dougseven; isolated and hardened here (escaped language
    // label, clipboard fallback, auto-detect size cap).
    // Obsidian wikilinks, as a tokenizer rather than a source rewrite.
    //
    // They used to be a regex over the raw source that spliced an <a> tag with
    // an inline onclick into the markdown, taking the target and the label
    // verbatim. That put attacker text inside a JavaScript string inside an
    // HTML attribute, two nested parsers deep, where a single quote is enough
    // to leave both. A tokenizer has no such position: the target reaches the
    // page only as an escaped attribute value, and the label only as tokens
    // marked itself renders.
    //
    // The two patterns and their order are the originals, so which text
    // becomes the target and which the label is unchanged, including the
    // ragged cases ([[a|b|c]] takes `a` and `b|c`; [[a|]] takes `a|` as both).
    instance.use({
      extensions: [{
        name: 'wikilink',
        level: 'inline',
        start(src) { return src.indexOf('[['); },
        tokenizer(src) {
          const aliased = /^\[\[([^\]|]+)\|([^\]]+)\]\]/.exec(src);
          const plain = aliased ? null : /^\[\[([^\]]+)\]\]/.exec(src);
          const match = aliased || plain;
          if (!match) return undefined;
          const target = match[1];
          const label = aliased ? match[2] : match[1];
          return {
            type: 'wikilink',
            raw: match[0],
            target,
            tokens: this.lexer.inlineTokens(label),
          };
        },
        renderer(token) {
          return `<a class="wikilink" data-wikilink="${escapeAttr(token.target)}">`
            + `${this.parser.parseInline(token.tokens)}</a>`;
        },
      }],
      renderer: {
        code({ text, lang }) {
          let highlighted = '';
          let displayLang = '';
          try {
            // Decision logic lives in code-language.js (pure, unit-tested):
            // explicit hints win, plaintext hints are first-class, unlabelled
            // blocks auto-detect over a curated subset with a relevance gate so
            // prose is never mislabelled as code (the VB.NET bug).
            const resolved = resolveCodeLanguage
              ? resolveCodeLanguage(lang, text, hljs, HLJS_AUTODETECT_MAX)
              : { html: escapeHtml(text), label: lang || '' };
            highlighted = resolved.html;
            displayLang = resolved.label;
          } catch (e) {
            highlighted = escapeHtml(text);
            displayLang = lang || '';
          }
          const langLabel = displayLang ? `<span class="code-lang">${escapeHtml(displayLang)}</span>` : '<span></span>';
          return (
            `<div class="code-block-wrapper">` +
            `<div class="code-block-header">${langLabel}` +
            `<button class="copy-code-btn" onclick="copyCode(this)" title="Copy code">${COPY_ICON}</button>` +
            `</div><pre><code class="hljs">${highlighted}</code></pre></div>`
          );
        },
        list(token) {
          // A reply that is only a number (`4471.`) is valid ordered-list
          // syntax, so it parses to a list whose single item is empty. The
          // reply then exists solely as the marker, which the bubble's fixed
          // list padding cannot contain, and it renders outside the bubble.
          // The intent was never a list, so emit the original text instead.
          //
          // Decision logic lives in empty-list.js (pure, unit-tested). It
          // returns null for anything it does not recognise, and `false` here
          // hands the token back to marked's own renderer untouched, so every
          // genuine list is completely unaffected.
          const text = emptyOrderedListText ? emptyOrderedListText(token) : null;
          if (text !== null) return `<p>${escapeHtml(text)}</p>\n`;
          return false;
        }
      }
    });

    function renderMarkdown(text, options = {}) {
      let src = text;

      // Pre-processing: Obsidian-specific syntax (before marked processes it)

      // Obsidian comments: %%text%% - hide completely
      src = src.replace(/%%[\s\S]*?%%/g, '');

      // Wikilinks are a marked extension now, not a source rewrite. See the
      // tokenizer above.

      // Highlights: ==text==
      src = src.replace(/==(.*?)==/g, '<mark>$1</mark>');

      // Tags: #tag (but not inside code blocks or headings)
      src = src.replace(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g, ' <span class="md-tag">#$1</span>');

      // Callouts: process before marked
      if (options.callouts !== false) {
        src = processCalloutsSrc(src);
      }

      // Render with marked
      let html = instance.parse(src);

      // Post-processing: clean up marked output for our styling

      // Wrap tables in a horizontal-scroll container so a wide table stays
      // within the message bubble and scrolls inside it, rather than pushing
      // the bubble wide and forcing the whole conversation to scroll sideways.
      // marked emits a bare, non-nested <table>, so this non-greedy wrap is
      // safe.
      html = html.replace(/<table>([\s\S]*?)<\/table>/g, '<div class="md-table-wrap"><table>$1</table></div>');

      // Convert relative file links to in-app wikilinks
      // Matches href values that end in .md, .yaml, .yml, .json, .txt and don't start with http/mailto/obsidian
      html = html.replace(/<a href="(?!https?:\/\/|mailto:|obsidian:\/\/)([^"]*\.(?:md|yaml|yml|json|txt))"([^>]*)>(.*?)<\/a>/g,
        (match, href, attrs, text) => `<a class="wikilink" onclick="openWikilink('${href.replace(/'/g, "\\'")}')">${text}</a>`);

      // Checkboxes: add accent colour
      html = html.replace(/<input.*?checked.*?disabled.*?>/g, '<input type="checkbox" checked disabled style="margin-right:8px;accent-color:var(--accent)">');
      html = html.replace(/<input.*?disabled.*?type="checkbox".*?>/g, '<input type="checkbox" disabled style="margin-right:8px">');

      return html;
    }

    function processCalloutsSrc(src) {
      // Process Obsidian callouts in raw source before marked
      // Callout: > [!type] title followed by > content
      const lines = src.split('\n');
      const result = [];
      let i = 0;

      while (i < lines.length) {
        const calloutMatch = lines[i].match(/^>\s*\[!(\w+)\]([+-])?\s*(.*)/);
        if (calloutMatch) {
          const type = calloutMatch[1].toLowerCase();
          const title = calloutMatch[3] || type.charAt(0).toUpperCase() + type.slice(1);
          const contentLines = [];
          i++;

          // Collect callout content (lines starting with >)
          while (i < lines.length && (lines[i].startsWith('>') || lines[i].trim() === '')) {
            if (lines[i].trim() === '' && i + 1 < lines.length && !lines[i + 1].startsWith('>')) break;
            let line = lines[i].replace(/^>\s?/, '');
            contentLines.push(line);
            i++;
          }

          const content = renderMarkdown(contentLines.join('\n'), { callouts: true });
          result.push(`<div class="callout callout-${type}"><div class="callout-title">${title}</div><div class="callout-content">${content}</div></div>`);
        } else {
          result.push(lines[i]);
          i++;
        }
      }

      return result.join('\n');
    }

    return { renderMarkdown };
  }

  /**
   * Route clicks on rendered wikilinks to the app's opener.
   *
   * The anchors used to carry `onclick="openWikilink('...')"`, which meant the
   * target was written into the page as source code and re-parsed by the
   * browser as JavaScript. One delegated listener replaces every one of them:
   * the target travels as data, is read back as data, and is never parsed as
   * anything.
   *
   * Delegated rather than bound per anchor because the markup is written with
   * innerHTML on every streaming frame, so per-element binding would have to
   * re-run after each one and would leak listeners for the elements it
   * replaced.
   *
   * @param {Document} doc
   * @param {(target: string) => void} onWikilink
   */
  function attachWikilinkHandler(doc, onWikilink) {
    doc.addEventListener('click', (event) => {
      const target = event.target;
      const anchor = target && target.closest ? target.closest('a.wikilink[data-wikilink]') : null;
      if (!anchor) return;
      event.preventDefault();
      onWikilink(anchor.getAttribute('data-wikilink'));
    });
  }

  return {
    createMarkdownRenderer,
    attachWikilinkHandler,
    escapeHtml,
    escapeAttr,
    COPY_ICON,
    CHECK_ICON,
    HLJS_AUTODETECT_MAX,
  };
}));
