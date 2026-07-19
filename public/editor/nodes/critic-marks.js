// CriticMarkup constructs as inline atom nodes on the free Tiptap core.
//
// Five constructs (CriticMarkup wire format, see review/criticmarkup.js):
//   {>>comment<<}{#c1}  {++insert++}{#s1}  {--delete--}  {~~old~>new~~}  {==highlight==}
//
// Design decisions:
//
//  - ATOMS, not marks. Construct content is held verbatim in node attrs and
//    re-emitted byte-for-byte by the serializer. Marks would route content
//    through prosemirror-markdown's text escaping (drifting bytes like
//    `**bold**` to `\*\*bold\*\*`) and let typing extend construct
//    boundaries invisibly. Atom content is not editable in place: review
//    decisions (accept / reject / resolve) are the editing surface, which
//    also means highlighted text cannot be edited out from under its
//    comment.
//  - Construct content renders as plain text (no nested markdown rendering
//    inside constructs); constructs do not nest.
//  - Constructs spanning multiple blocks (a blank line inside) do not parse
//    as constructs; they stay literal text, matching common CriticMarkup practice.
//  - No paid extensions: this file plus review/* is the whole review layer.
//
// The markdown-it inline rule consumes constructs at `{` (a markdown-it
// terminator char, so the rule is consulted there) using the shared
// scanConstruct, and emits one token per construct. CriticMarkup inside
// fenced code blocks and inline code stays literal automatically: fences
// never reach inline rules and backticks consume code spans first.

import { Node, mergeAttributes } from '../../vendor/tiptap-bundle.mjs';
import { scanConstruct, serializeSegment } from '../review/criticmarkup.js';

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// markdown-it inline rule
// ---------------------------------------------------------------------------

const TOKEN_BY_TYPE = {
  comment: 'critic_comment',
  insert: 'critic_insert',
  delete: 'critic_delete',
  substitution: 'critic_substitution',
  highlight: 'critic_highlight',
};

function criticTokenize(state, silent) {
  if (state.src.charCodeAt(state.pos) !== 0x7B /* { */) return false;
  const hit = scanConstruct(state.src, state.pos);
  if (!hit) return false;
  // Constructs must resolve within this inline block.
  if (hit.end > state.posMax) return false;
  if (!silent) {
    const seg = hit.segment;
    const token = state.push(TOKEN_BY_TYPE[seg.type], '', 0);
    if (seg.type === 'substitution') {
      token.attrSet('from', seg.from);
      token.attrSet('to', seg.to);
    } else {
      token.attrSet('content', seg.content);
    }
    if (seg.id) token.attrSet('id', seg.id);
    token.markup = 'criticmarkup';
  }
  state.pos = hit.end;
  return true;
}

function renderAtom(cls, dataAttrs, inner) {
  const attrs = Object.entries(dataAttrs)
    .filter(([, v]) => v != null)
    .map(([k, v]) => ` data-${k}="${escapeHtmlAttr(v)}"`)
    .join('');
  return `<span class="${cls}"${attrs}>${inner}</span>`;
}

export function registerCriticMarkdownIt(md) {
  md.inline.ruler.after('emphasis', 'criticmarkup', criticTokenize);
  md.renderer.rules.critic_comment = (tokens, idx) => {
    const t = tokens[idx];
    return renderAtom('critic critic-comment', { 'critic-content': t.attrGet('content'), 'critic-id': t.attrGet('id') },
      escapeHtml(t.attrGet('content') || ''));
  };
  md.renderer.rules.critic_insert = (tokens, idx) => {
    const t = tokens[idx];
    return renderAtom('critic critic-insert', { 'critic-content': t.attrGet('content'), 'critic-id': t.attrGet('id') },
      escapeHtml(t.attrGet('content') || ''));
  };
  md.renderer.rules.critic_delete = (tokens, idx) => {
    const t = tokens[idx];
    return renderAtom('critic critic-delete', { 'critic-content': t.attrGet('content'), 'critic-id': t.attrGet('id') },
      escapeHtml(t.attrGet('content') || ''));
  };
  md.renderer.rules.critic_substitution = (tokens, idx) => {
    const t = tokens[idx];
    return renderAtom('critic critic-substitution', { 'critic-from': t.attrGet('from'), 'critic-to': t.attrGet('to'), 'critic-id': t.attrGet('id') },
      escapeHtml(t.attrGet('from') || ''));
  };
  md.renderer.rules.critic_highlight = (tokens, idx) => {
    const t = tokens[idx];
    return renderAtom('critic critic-highlight', { 'critic-content': t.attrGet('content'), 'critic-id': t.attrGet('id') },
      escapeHtml(t.attrGet('content') || ''));
  };
}

// ---------------------------------------------------------------------------
// node factories
// ---------------------------------------------------------------------------

// Shared spec for the four content-carrying constructs. `segType` is the
// review/criticmarkup.js segment type; `cls` the DOM class. Comments render
// as a compact marker (their text lives in the review sidebar); the other
// constructs render their content inline.
function contentAtom({ name, segType, cls, registerParser = false, marker = false }) {
  return Node.create({
    name,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        content: { default: '' },
        id: { default: null },
      };
    },

    parseHTML() {
      return [{
        tag: `span.${cls.split(' ').join('.')}`,
        priority: 1000,
        getAttrs: (el) => ({
          content: el.getAttribute('data-critic-content') || '',
          id: el.getAttribute('data-critic-id') || null,
        }),
      }];
    },

    renderHTML({ node, HTMLAttributes }) {
      const attrs = mergeAttributes(HTMLAttributes, {
        class: cls,
        'data-critic-content': node.attrs.content,
        ...(node.attrs.id ? { 'data-critic-id': node.attrs.id } : {}),
      });
      if (marker) {
        // Compact marker chip. The visible number is a CSS counter in
        // document order: pure presentation, carrying position rather than
        // identity. Cross-party references quote the comment text (the
        // agent convention), so display numbers are free to renumber as
        // items resolve; wire-format anchor ids stay invisible plumbing
        // for attribution and threading. Full text shows in the sidebar
        // and on hover.
        attrs.title = node.attrs.content;
        return ['span', attrs];
      }
      return ['span', attrs, node.attrs.content];
    },

    renderText({ node }) {
      return serializeSegment({ type: segType, content: node.attrs.content, id: node.attrs.id });
    },

    addStorage() {
      return {
        markdown: {
          serialize(state, node) {
            state.write(serializeSegment({ type: segType, content: node.attrs.content, id: node.attrs.id }));
          },
          parse: registerParser ? {
            setup(markdownit) {
              registerCriticMarkdownIt(markdownit);
            },
          } : {},
        },
      };
    },
  });
}

// The markdown-it plugin is registered once, on CriticComment.
export const CriticComment = contentAtom({ name: 'criticComment', segType: 'comment', cls: 'critic critic-comment', registerParser: true, marker: true });
export const CriticInsert = contentAtom({ name: 'criticInsert', segType: 'insert', cls: 'critic critic-insert' });
export const CriticDelete = contentAtom({ name: 'criticDelete', segType: 'delete', cls: 'critic critic-delete' });
export const CriticHighlight = contentAtom({ name: 'criticHighlight', segType: 'highlight', cls: 'critic critic-highlight' });

export const CriticSubstitution = Node.create({
  name: 'criticSubstitution',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      from: { default: '' },
      to: { default: '' },
      id: { default: null },
    };
  },

  parseHTML() {
    return [{
      tag: 'span.critic.critic-substitution',
      priority: 1000,
      getAttrs: (el) => ({
        from: el.getAttribute('data-critic-from') || '',
        to: el.getAttribute('data-critic-to') || '',
        id: el.getAttribute('data-critic-id') || null,
      }),
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      class: 'critic critic-substitution',
      'data-critic-from': node.attrs.from,
      'data-critic-to': node.attrs.to,
      ...(node.attrs.id ? { 'data-critic-id': node.attrs.id } : {}),
    }),
      ['span', { class: 'critic-sub-from' }, node.attrs.from],
      ['span', { class: 'critic-sub-arrow' }, '→'],
      ['span', { class: 'critic-sub-to' }, node.attrs.to],
    ];
  },

  renderText({ node }) {
    return serializeSegment({ type: 'substitution', from: node.attrs.from, to: node.attrs.to, id: node.attrs.id });
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(serializeSegment({ type: 'substitution', from: node.attrs.from, to: node.attrs.to, id: node.attrs.id }));
        },
        parse: {},
      },
    };
  },
});

export const criticExtensions = [CriticComment, CriticInsert, CriticDelete, CriticSubstitution, CriticHighlight];
