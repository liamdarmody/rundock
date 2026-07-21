// SoftHardBreak: extends Tiptap's HardBreak with a markdown serialiser that
// restores the ORIGINAL break marker on save.
//
// Why this exists: Markdown.configure({ breaks: true }) is required for
// Obsidian-flavoured line-break semantics (each \n in source becomes a
// hardBreak in the editor). With breaks:true both a soft break (\n), a
// trailing-two-space hard break, and a backslash hard break all render as a
// <br>, so a naive serialiser collapses every break to a bare \n and deletes
// the trailing spaces or backslash (OFM parity corpus: line-breaks). This
// records the exact source marker per break at parse and re-emits it on save.
//
// The factory disables StarterKit's built-in HardBreak via
// StarterKit.configure({ hardBreak: false }) and registers this in its place.

import { HardBreak } from '../../vendor/tiptap-bundle.mjs';

const BREAK_ATTR = 'data-break-src';

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// For each newline in an inline block, work out the break marker that preceded
// it (a trailing backslash, two-or-more trailing spaces, or nothing for a soft
// break) and stamp it onto the soft/hard break tokens. Also override the break
// renderers so the marker reaches the parsed HTML as a <br> attribute.
function installBreakMarkerRule(md) {
  if (!md || !md.core || md.core.__rundockBreakMarker) return;
  md.core.__rundockBreakMarker = true;
  md.core.ruler.push('rundock_break_marker', (state) => {
    for (const tok of state.tokens) {
      if (tok.type !== 'inline' || !tok.children || tok.content.indexOf('\n') < 0) continue;
      const lines = tok.content.split('\n');
      const markers = [];
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        const bs = line.match(/\\+$/);
        const sp = line.match(/[ \t]+$/);
        if (bs && bs[0].length % 2 === 1) markers.push('\\');       // trailing odd backslash
        else if (sp && sp[0].length >= 2) markers.push(sp[0]);       // 2+ trailing spaces
        else markers.push('');                                       // soft break
      }
      let bi = 0;
      for (const c of tok.children) {
        if (c.type === 'softbreak' || c.type === 'hardbreak') { c.attrSet(BREAK_ATTR, markers[bi] || ''); bi++; }
      }
    }
  });
  const brRender = (tokens, idx) => `<br ${BREAK_ATTR}="${escapeAttr(tokens[idx].attrGet(BREAK_ATTR) || '')}">\n`;
  md.renderer.rules.hardbreak = brRender;
  const softDefault = md.renderer.rules.softbreak;
  md.renderer.rules.softbreak = (tokens, idx, options, env, self) =>
    options.breaks ? brRender(tokens, idx) : (softDefault ? softDefault(tokens, idx, options, env, self) : '\n');
}

export const SoftHardBreak = HardBreak.extend({
  name: 'hardBreak',

  addAttributes() {
    return {
      ...this.parent?.(),
      breakSrc: {
        default: '',
        parseHTML: (el) => el.getAttribute(BREAK_ATTR) || '',
        renderHTML: () => ({}),
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) { state.write((node.attrs.breakSrc || '') + '\n'); },
        parse: { setup(md) { installBreakMarkerRule(md); } },
      },
    };
  },
});
