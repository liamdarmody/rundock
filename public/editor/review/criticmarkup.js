// CriticMarkup parser and serializer. DOM-free on purpose: imported by Node
// tests directly and by the review mark extensions in the browser.
//
// Wire format (CriticMarkup):
//
//   {>>comment<<}   {++insert++}   {--delete--}   {~~old~>new~~}   {==highlight==}
//
// each optionally anchored by an id suffix: {#c1} (comments) / {#s1}
// (suggestions). Rules pinned here:
//
//  - Constructs do not nest. Content runs to the FIRST closing marker of the
//    same construct; anything inside is plain content.
//  - A substitution without `~>` in its content is not a substitution; it
//    stays literal text.
//  - Unterminated or half-formed markers stay literal text.
//  - serializeInline(parseInline(text)) === text for any input (byte-exact).
//
// Segment shapes:
//   { type: 'text', text }
//   { type: 'comment'|'insert'|'delete'|'highlight', content, id }
//   { type: 'substitution', from, to, id }

const OPENERS = {
  '>>': { type: 'comment', close: '<<}' },
  '++': { type: 'insert', close: '++}' },
  '--': { type: 'delete', close: '--}' },
  '~~': { type: 'substitution', close: '~~}' },
  '==': { type: 'highlight', close: '==}' },
};

const ID_SUFFIX_RE = /^\{#([A-Za-z0-9_-]+)\}/;
const SUBSTITUTION_ARROW = '~>';

// Attempts to read one construct at text[i] (which must be '{'). Returns
// { segment, end } or null when the text at i is not a valid construct.
export function scanConstruct(text, i) {
  const marker = text.slice(i + 1, i + 3);
  const def = OPENERS[marker];
  if (!def) return null;
  const contentStart = i + 3;
  const closeAt = text.indexOf(def.close, contentStart);
  if (closeAt === -1) return null;
  const content = text.slice(contentStart, closeAt);
  let end = closeAt + def.close.length;

  let id = null;
  const idMatch = text.slice(end).match(ID_SUFFIX_RE);
  if (idMatch) {
    id = idMatch[1];
    end += idMatch[0].length;
  }

  if (def.type === 'substitution') {
    const arrow = content.indexOf(SUBSTITUTION_ARROW);
    if (arrow === -1) return null;
    return {
      segment: { type: 'substitution', from: content.slice(0, arrow), to: content.slice(arrow + SUBSTITUTION_ARROW.length), id },
      end,
    };
  }
  return { segment: { type: def.type, content, id }, end };
}

export function parseInline(text) {
  const segments = [];
  let literal = '';
  let i = 0;
  const flush = () => {
    if (literal) { segments.push({ type: 'text', text: literal }); literal = ''; }
  };
  while (i < text.length) {
    if (text[i] === '{') {
      const hit = scanConstruct(text, i);
      if (hit) {
        flush();
        segments.push(hit.segment);
        i = hit.end;
        continue;
      }
    }
    literal += text[i];
    i += 1;
  }
  flush();
  if (!segments.length) segments.push({ type: 'text', text: '' });
  return segments;
}

export function serializeSegment(seg) {
  const idSuffix = seg.id ? `{#${seg.id}}` : '';
  switch (seg.type) {
    case 'text': return seg.text;
    case 'comment': return `{>>${seg.content}<<}${idSuffix}`;
    case 'insert': return `{++${seg.content}++}${idSuffix}`;
    case 'delete': return `{--${seg.content}--}${idSuffix}`;
    case 'highlight': return `{==${seg.content}==}${idSuffix}`;
    case 'substitution': return `{~~${seg.from}~>${seg.to}~~}${idSuffix}`;
    default: throw new Error(`serializeSegment: unknown type ${seg.type}`);
  }
}

export function serializeInline(segments) {
  return segments.map(serializeSegment).join('');
}

// Groups parsed segments into review-model units:
//   { type: 'anchored-comment', highlight, comment }: {==x==}{>>y<<}{#c1}
//   { type: 'comment', comment }: standalone comment
//   { type: 'suggestion', segment }: insert/delete/substitution
//   { type: 'text', segment }
export function groupAnnotations(segments) {
  const groups = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'highlight' && segments[i + 1] && segments[i + 1].type === 'comment') {
      groups.push({ type: 'anchored-comment', highlight: seg, comment: segments[i + 1] });
      i += 1;
    } else if (seg.type === 'comment') {
      groups.push({ type: 'comment', comment: seg });
    } else if (seg.type === 'insert' || seg.type === 'delete' || seg.type === 'substitution') {
      groups.push({ type: 'suggestion', segment: seg });
    } else {
      groups.push({ type: 'text', segment: seg });
    }
  }
  return groups;
}
