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
//
// ===========================================================================
// THE DECISION: agent markdown may NOT contain HTML.
// ===========================================================================
//
// This renderer's input is agent output, and agent output is not the user. It
// carries text the user never wrote: a file in the workspace, a page an agent
// fetched, a skill or agent file installed from a marketplace. Routines make
// agents produce it on a timer, unattended, with nobody reading it as it
// arrives. So the question is not whether the author is trusted. It is what a
// document is allowed to do to the page it lands on, and the answer here is:
// carry text and the constructs this renderer knows how to build, nothing else.
//
// A tag written in a document therefore renders as the characters of that tag.
// The alternative was a sanitiser, and it was weighed rather than dismissed:
//
//   What escaping costs. An agent that writes <details> or <kbd> gets the text
//   of it. That is a visible failure the reader can see and report, not a
//   silent one, and if a construct ever earns its place the answer is a
//   tokenizer for it on the same terms as callouts and wikilinks, which is how
//   every construct this renderer supports already works. Nothing in the app
//   needs HTML in a document today: raw HTML was never a feature here, it was
//   the parser's default left unguarded.
//
//   What a sanitiser costs. A vendored bundle, its licence record, and a
//   version to keep chasing, in an app that has no build step and must work
//   offline. More to the point, it is an answer that has to be re-given: an
//   allowlist to maintain, and a mutation-XSS literature to track, for a
//   capability nothing is asking for. Escaping answers the question once and
//   the question stays answered.
//
// So: no sanitiser, no new dependency, and AC-7 does not arise.
//
// COMMENTS ARE DROPPED, NOT ESCAPED. The one exception, and it is behaviour
// preservation rather than leniency. The streaming path renders the raw
// response text, which carries Rundock's own <!-- RUNDOCK:... --> markers.
// Those are invisible today because the parser passed them through; escaping
// them would have printed the app's internal protocol into the conversation.
// Dropping leaves every comment exactly as visible as it was, which is not at
// all.
//
// NO CONTENT-SECURITY-POLICY, and what carries the risk instead. A CSP worth
// having forbids inline handlers, and the app has 28 of them in index.html and
// 47 more written by client scripts outside this file. A policy with
// 'unsafe-inline' is not a policy, and one without it breaks the app, so the
// honest state is: not yet, and the prerequisite is removing those handlers.
// This card removed the two that this renderer emitted, which is the part of
// the surface it owns. Until a policy exists, what stands between agent output
// and the page is this file: no path through it produces markup the document
// controls, which is a stronger claim than a policy makes and a narrower one,
// because it holds only for what is rendered HERE. The seventeen other
// innerHTML assignments in the client are not covered by it and want their own
// card.
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

    // Hrefs that name a file in the workspace rather than a place on the web.
    // Same extensions and same exclusions the post-processing regex used.
    const WORKSPACE_FILE_HREF = /^(?!https?:\/\/|mailto:|obsidian:\/\/).*\.(?:md|yaml|yml|json|txt)$/;

    // Destinations a link or an image may point at.
    //
    // A FIFTH injection point, named by neither the card nor the frozen
    // criteria and found while closing the fourth: marked applies no scheme
    // filter to a link destination, so `[click](javascript:alert(1))` produced
    // an anchor that ran the expression on click, and an image src did the same
    // without one. Same class as the other four, same renderer, so it is closed
    // here rather than left for a card of its own.
    //
    // Stated as a shape rather than a list of bad schemes, because a blocklist
    // has to be right about character references and this does not have to know
    // about them at all. A destination is allowed when it either begins with a
    // scheme that is spelled out here, or has no colon before the first path,
    // query or fragment character, which is what makes it relative. So
    // `java&Tab;script:alert(1)` is refused for having a colon where a relative
    // path cannot have one, without anyone having to decode it first.
    const ALLOWED_SCHEME = /^(?:https?:\/\/|mailto:|obsidian:\/\/)/i;
    const RELATIVE_HREF = /^[^:/?#]*(?:[/?#]|$)/;
    function isNavigableHref(href) {
      const value = String(href == null ? '' : href);
      return ALLOWED_SCHEME.test(value) || RELATIVE_HREF.test(value);
    }

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
        // Obsidian highlights: ==text==.
        //
        // Was a whole-document regex that spliced <mark> into the source, so
        // it fired inside fenced code too and the block rendered visible mark
        // tags. The pattern is the original, non-greedy and single-line.
        name: 'highlight',
        level: 'inline',
        start(src) {
          const i = src.indexOf('==');
          return i === -1 ? undefined : i;
        },
        tokenizer(src) {
          const match = /^==(.*?)==/.exec(src);
          if (!match) return undefined;
          return { type: 'highlight', raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
        },
        renderer(token) {
          return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
        },
      }, {
        // Obsidian tags: #tag.
        //
        // Was a whole-document regex that fired inside fenced code, and that
        // consumed the whitespace before the tag and put a single space back,
        // so a tag at the start of a line silently joined it to the line above.
        //
        // The boundary is the delicate part, and it is `start` that holds it.
        // marked calls `start` with the source MINUS its first character, to
        // work out where to cut the current text run short, so a `#` at index 0
        // of what it passes is by definition preceded by the character that was
        // sliced off, and is mid-word. Accepting it is what made `C#sharp`
        // render `#sharp` as a tag. Only a `#` that follows whitespace is
        // offered, which is the condition the old pattern expressed by
        // consuming that whitespace.
        //
        // A tag that opens the source needs no offer: the tokenizer is called
        // at that position before any text is consumed.
        name: 'tag',
        level: 'inline',
        start(src) {
          const match = /\s#[a-zA-Z]/.exec(src);
          return match ? match.index + 1 : undefined;
        },
        tokenizer(src) {
          const match = /^#([a-zA-Z][a-zA-Z0-9_/-]*)/.exec(src);
          if (!match) return undefined;
          return { type: 'tag', raw: match[0], name: match[1] };
        },
        renderer(token) {
          return `<span class="md-tag">#${escapeHtml(token.name)}</span>`;
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
        // Raw HTML in the document. See THE DECISION at the top of this file:
        // it renders as its own characters, so nothing the document says can
        // become an element or an attribute. Comments are dropped instead of
        // escaped, for the reason recorded there.
        html(token) {
          return escapeHtml(token.text.replace(/<!--[\s\S]*?-->/g, ''));
        },
        // Relative links to workspace files open in the app instead of
        // navigating, so they are rewritten into wikilinks.
        //
        // This used to be a regex over the FINISHED HTML that pulled the href
        // back out of the attribute marked had just written and pasted it into
        // an inline handler, escaping it with `href.replace(/'/g, "\\'")`.
        // That is a JavaScript rule applied to a value going into an HTML
        // attribute, and the two languages are not layered the way the escape
        // assumes: the browser decodes character references in the attribute
        // BEFORE any of it is JavaScript, so `&#39;` arrives as a quote the
        // replace never saw. `[a](<&#39;&#41;;alert&#40;1&#41;;//.md>)` was
        // enough to run arbitrary code on click. Backslashes were not, because
        // marked percent-encodes those in an href.
        //
        // Deciding at the link token removes both halves of the problem: there
        // is no HTML to re-parse, and the href goes into a data attribute
        // rather than a handler, so no JavaScript position exists to escape
        // for. Which hrefs are claimed is unchanged, and so is the value
        // handed to the opener.
        // Every link is written here, not only the rewritten ones. marked's own
        // link renderer escapes an href in a mode that deliberately leaves
        // existing character references intact, which is correct for a URL and
        // wrong for this: `[x](&#106;avascript:alert(1))` reaches the attribute
        // with the reference unchanged, and the browser decodes it to
        // `javascript:` before deciding what the URL means. Writing the
        // attribute here, escaped as an attribute value, means the bytes
        // checked below are the bytes the browser reads.
        link(token) {
          const href = token.href;
          const text = this.parser.parseInline(token.tokens);
          if (!isNavigableHref(href)) return text;
          if (WORKSPACE_FILE_HREF.test(href)) {
            return `<a class="wikilink" data-wikilink="${escapeAttr(href)}">${text}</a>`;
          }
          const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
          return `<a href="${escapeAttr(href)}"${title}>${text}</a>`;
        },
        // An image destination is a URL the page fetches, so it is the same
        // question as a link destination and gets the same answer.
        image(token) {
          const alt = escapeAttr(token.text || '');
          if (!isNavigableHref(token.href)) return escapeHtml(token.text || '');
          const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
          return `<img src="${escapeAttr(token.href)}" alt="${alt}"${title}>`;
        },
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
            `<button class="copy-code-btn" title="Copy code">${COPY_ICON}</button>` +
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

      // Highlights and tags are marked extensions now, not source rewrites.

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

      // Relative file links become wikilinks in the link renderer now, not by
      // rewriting the finished HTML. See WORKSPACE_FILE_HREF above.

      // Checkboxes: add accent colour
      html = html.replace(/<input.*?checked.*?disabled.*?>/g, '<input type="checkbox" checked disabled style="margin-right:8px;accent-color:var(--accent)">');
      html = html.replace(/<input.*?disabled.*?type="checkbox".*?>/g, '<input type="checkbox" disabled style="margin-right:8px">');

      return html;
    }

    return { renderMarkdown };
  }

  /**
   * Copy a code block's text, from its button.
   *
   * Moved here with the markup it belongs to, and reached by delegation rather
   * than by the `onclick="copyCode(this)"` the renderer used to write. The
   * attribute was never an injection point, since nothing from the document
   * reached it, but a Content-Security-Policy worth having forbids inline
   * handlers and every surviving one is a reason it cannot be turned on.
   *
   * Everything is taken from the button's own document, so the same code works
   * in the app and under a test DOM.
   *
   * @param {Element} button
   */
  function copyCode(button) {
    const doc = button.ownerDocument;
    const view = doc.defaultView;
    const codeEl = button.closest('.code-block-wrapper')
      && button.closest('.code-block-wrapper').querySelector('code');
    if (!codeEl) return;
    const text = codeEl.textContent;
    const done = () => {
      button.innerHTML = CHECK_ICON;
      button.classList.add('copied');
      view.setTimeout(() => { button.innerHTML = COPY_ICON; button.classList.remove('copied'); }, 2000);
    };
    // navigator.clipboard is unavailable in non-secure contexts (e.g. VPS over http).
    if (view.navigator.clipboard && view.navigator.clipboard.writeText) {
      view.navigator.clipboard.writeText(text).then(done).catch(() => {});
    } else {
      try {
        const ta = doc.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        doc.body.appendChild(ta); ta.select(); doc.execCommand('copy'); ta.remove();
        done();
      } catch (e) { /* copy unavailable: no-op */ }
    }
  }

  /**
   * Route clicks on a rendered code block's copy button to copyCode.
   *
   * @param {Document} doc
   */
  function attachCodeCopyHandler(doc) {
    doc.addEventListener('click', (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest('.copy-code-btn') : null;
      if (button) copyCode(button);
    });
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
    attachCodeCopyHandler,
    escapeHtml,
    escapeAttr,
    COPY_ICON,
    CHECK_ICON,
    HLJS_AUTODETECT_MAX,
  };
}));
