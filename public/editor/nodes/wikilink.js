// Wikilink: inline atom node carrying Obsidian-flavoured [[target]] and
// [[target|alias]] syntax through ProseMirror.
//
// Renders as <a class="wikilink" data-target=... data-alias=...>display</a>.
// No href attribute is set, which prevents StarterKit's Link mark from
// capturing the element via its a[href] selector. Click handling is delegated
// from the editor mount point and routed to Rundock's existing openWikilink
// flow via the editor module's onWikilinkClick callback.
//
// Production differs from the validation prototype in one place: source-side
// parsing is a markdown-it plugin rather than a regex pre-processor. This
// closes the html:true XSS surface the prototype relied on. Round-trip and
// rendering behaviour are otherwise identical.

import { Node, mergeAttributes, InputRule } from '../../vendor/tiptap-bundle.mjs';

const WIKILINK_INLINE_RE = /\[\[([^\[\]\|\n]+?)(?:\|([^\[\]\|\n]+?))?\]\]/g;

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// markdown-it inline rule. Detects [[target]] or [[target|alias]] at the
// current state position and emits a single `wikilink` token. Skips when the
// surrounding context is inline code or a fenced code block: markdown-it's
// own backtick rule runs first and consumes inline code spans, so they never
// reach this rule; fenced code blocks are block-level and not visited by
// inline rules at all.
function wikilinkTokenize(state, silent) {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x5B /* [ */) return false;
  if (state.src.charCodeAt(start + 1) !== 0x5B /* [ */) return false;

  const inner_start = start + 2;
  let end = -1;
  for (let i = inner_start; i < state.posMax - 1; i++) {
    const c = state.src.charCodeAt(i);
    if (c === 0x0A /* \n */) return false; // wikilinks do not span lines
    if (c === 0x5B /* [ */) return false;  // disallow nested [
    if (c === 0x5D /* ] */ && state.src.charCodeAt(i + 1) === 0x5D /* ] */) {
      end = i;
      break;
    }
  }
  if (end === -1) return false;

  const inner = state.src.slice(inner_start, end);
  const pipe = inner.indexOf('|');
  const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const alias  = (pipe === -1 ? null  : inner.slice(pipe + 1).trim()) || null;
  if (!target) return false;

  if (!silent) {
    const token = state.push('wikilink', '', 0);
    token.attrSet('target', target);
    if (alias) token.attrSet('alias', alias);
    token.markup = '[[...]]';
  }

  state.pos = end + 2;
  return true;
}

function wikilinkRender(tokens, idx) {
  const token = tokens[idx];
  const target = token.attrGet('target') || '';
  const alias  = token.attrGet('alias');
  const display = alias || target;
  const aliasAttr = alias ? ` data-alias="${escapeHtmlAttr(alias)}"` : '';
  return `<a class="wikilink" tabindex="0" data-target="${escapeHtmlAttr(target)}"${aliasAttr}>${escapeHtmlAttr(display)}</a>`;
}

export function registerWikilinkMarkdownIt(md) {
  md.inline.ruler.after('emphasis', 'wikilink', wikilinkTokenize);
  md.renderer.rules.wikilink = wikilinkRender;
}

export const Wikilink = Node.create({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      target: { default: '' },
      alias:  { default: null },
    };
  },

  parseHTML() {
    return [{
      tag: 'a.wikilink',
      // Above the StarterKit Link mark so the Wikilink node wins when both
      // could match. Without this, <a class="wikilink"> would be parsed as a
      // Link mark on plain text and would round-trip as [Doc](#).
      priority: 1000,
      getAttrs: (el) => {
        if (!(el instanceof HTMLElement) || !el.classList.contains('wikilink')) return false;
        return {
          target: el.getAttribute('data-target') || '',
          alias:  el.getAttribute('data-alias') || null,
        };
      },
    }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const display = node.attrs.alias || node.attrs.target;
    const attrs = {
      class: 'wikilink',
      'data-target': node.attrs.target,
      tabindex: '0',
    };
    if (node.attrs.alias) attrs['data-alias'] = node.attrs.alias;
    return ['a', mergeAttributes(HTMLAttributes, attrs), display];
  },

  renderText({ node }) {
    return node.attrs.alias
      ? `[[${node.attrs.target}|${node.attrs.alias}]]`
      : `[[${node.attrs.target}]]`;
  },

  addInputRules() {
    const type = this.type;
    return [
      new InputRule({
        find: WIKILINK_INLINE_RE,
        handler: ({ state, range, match }) => {
          const $pos = state.doc.resolve(range.from);
          if ($pos.parent.type.spec.code) return; // inside a code block
          // Only fire on literal typed text. Tiptap also runs input rules on
          // Enter, reconstructing the block's text with each leaf node's
          // renderText, so an EXISTING wikilink atom re-serialises to
          // `[[target]]` and this rule matches its own output. The matched
          // range then spans that atom (1 position rendering as many chars),
          // and replacing it deletes the surrounding text and sibling atoms.
          // Requiring the doc text under the range to equal the literal match
          // means an atom in the range (which contributes no text) fails the
          // check, so only genuinely typed `[[...]]` is ever replaced.
          if (state.doc.textBetween(range.from, range.to) !== match[0]) return;
          const target = (match[1] || '').trim();
          const alias  = match[2] ? match[2].trim() : null;
          if (!target) return;
          state.tr.replaceWith(range.from, range.to, type.create({ target, alias }));
        },
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(
            node.attrs.alias
              ? `[[${node.attrs.target}|${node.attrs.alias}]]`
              : `[[${node.attrs.target}]]`
          );
        },
        parse: {
          setup(markdownit) {
            registerWikilinkMarkdownIt(markdownit);
          },
        },
      },
    };
  },
});
