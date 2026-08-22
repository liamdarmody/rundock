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

    // Whether the callout tokenizer is live for the current render. The option
    // is per-call and an extension is per-instance, so the flag bridges them.
    // Safe because rendering is synchronous: nothing can interleave between
    // the assignment below and the parse it belongs to, and the only re-entry
    // is a callout's own body, which renders with callouts on either way.
    let calloutsEnabled = true;

    instance.use({
      extensions: [{
        // Obsidian callouts, as a block tokenizer rather than a source rewrite.
        //
        // The box used to be built by string concatenation before any parser
        // ran, with the title interpolated raw:
        //   `<div class="callout-title">${title}</div>`
        // The title is the rest of the `> [!type]` line, straight from the
        // document, so `> [!note] <img src=x onerror=alert(1)>` put an image
        // element with a handler into the page with marked not involved at any
        // point. As a tokenizer, the title is a value the renderer escapes.
        //
        // The title is TEXT, deliberately, which is also what it was: the box
        // was block-level HTML, so marked never parsed markdown inside it and
        // `**bold**` in a title has always rendered literally. One thing that
        // did work no longer does: a wikilink in a title was rewritten by the
        // old source pass before the callout pass saw it, and a tokenizer has
        // no such ordering. Titles are a label, and a label that renders
        // exactly the characters written in it is the behaviour to want here.
        name: 'callout',
        level: 'block',
        start(src) {
          const m = /^>\s*\[!\w+\]/m.exec(src);
          return m ? m.index : undefined;
        },
        tokenizer(src) {
          if (!calloutsEnabled) return undefined;
          const lines = src.split('\n');
          const head = /^>\s*\[!(\w+)\]([+-])?\s*(.*)/.exec(lines[0]);
          if (!head) return undefined;
          const calloutType = head[1].toLowerCase();
          const title = head[3] || calloutType.charAt(0).toUpperCase() + calloutType.slice(1);

          // Content collection, unchanged from the original loop: quoted lines
          // belong to the box, a blank line belongs to it only when the box
          // continues after it, and a blank line before anything unquoted ends
          // it.
          const contentLines = [];
          let i = 1;
          while (i < lines.length && (lines[i].startsWith('>') || lines[i].trim() === '')) {
            if (lines[i].trim() === '' && i + 1 < lines.length && !lines[i + 1].startsWith('>')) break;
            contentLines.push(lines[i].replace(/^>\s?/, ''));
            i++;
          }

          return {
            type: 'callout',
            raw: lines.slice(0, i).join('\n') + (i < lines.length ? '\n' : ''),
            calloutType,
            title,
            tokens: this.lexer.blockTokens(contentLines.join('\n'), []),
          };
        },
        renderer(token) {
          return `<div class="callout callout-${token.calloutType}">`
            + `<div class="callout-title">${escapeHtml(token.title)}</div>`
            + `<div class="callout-content">${this.parser.parse(token.tokens)}</div></div>`;
        },
      }, {
        // Obsidian wikilinks, as a tokenizer rather than a source rewrite.
        //
        // They used to be a regex over the raw source that spliced an <a> tag
        // with an inline onclick into the markdown, taking the target and the
        // label verbatim. That put attacker text inside a JavaScript string
        // inside an HTML attribute, two nested parsers deep, where a single
        // quote is enough to leave both. A tokenizer has no such position: the
        // target reaches the page only as an escaped attribute value, and the
        // label only as tokens marked itself renders.
        //
        // The two patterns and their order are the originals, so which text
        // becomes the target and which the label is unchanged, including the
        // ragged cases ([[a|b|c]] takes `a` and `b|c`; [[a|]] takes `a|` as
        // both).
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
        // Syntax-highlight fenced code blocks (highlight.js, vendored locally)
        // and wrap them with a header bar showing the language label and a copy
        // button. Originating contributions: copy button (#6/#7) and syntax
        // highlighting (#10/#11) by @dougseven; isolated and hardened here
        // (escaped language label, clipboard fallback, auto-detect size cap).
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

      // Callouts are a marked extension now, not a source rewrite. The flag
      // it reads is set here so the per-call option still means what it did.
      calloutsEnabled = options.callouts !== false;

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
