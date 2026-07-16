// Quote-based text anchoring for sidecar reviews (W3C TextQuoteSelector
// model): a comment anchors to { quote, prefix, suffix } captured from the
// rendered document's linearised text. Re-anchoring searches for the quote
// and disambiguates duplicates by surrounding context; a quote that no
// longer exists resolves to null and the caller marks the item orphaned
// (never dropped).
//
// DOM-light: everything operates on a text index built from a root element,
// so the engine tests under jsdom and runs identically against the artifact
// iframe's document.

export const CONTEXT_LENGTH = 32;

// Linearise every text node under root into one string, remembering where
// each node starts, so string offsets map back to DOM positions.
export function buildTextIndex(root) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes = [];
  let text = '';
  let n;
  while ((n = walker.nextNode())) {
    nodes.push({ node: n, start: text.length });
    text += n.nodeValue;
  }
  return { root, text, nodes };
}

// Capture a selector for the [start, end) span of the index's text.
export function captureSelector(index, start, end, ctx = CONTEXT_LENGTH) {
  if (!(start >= 0) || !(end > start) || end > index.text.length) return null;
  return {
    quote: index.text.slice(start, end),
    prefix: index.text.slice(Math.max(0, start - ctx), start),
    suffix: index.text.slice(end, end + ctx),
  };
}

// Map a DOM Range (whose boundary containers are text nodes under root)
// to [start, end) offsets in the index. Returns null for anything else:
// callers treat that as "no usable selection".
export function rangeToOffsets(index, range) {
  const locate = (container, offset) => {
    const entry = index.nodes.find((e) => e.node === container);
    return entry ? entry.start + offset : null;
  };
  const start = locate(range.startContainer, range.startOffset);
  const end = locate(range.endContainer, range.endOffset);
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

// How many characters of `expected` match `actual`, comparing from the end
// (for prefixes) or the start (for suffixes).
function matchLen(expected, actual, fromEnd) {
  let n = 0;
  const max = Math.min(expected.length, actual.length);
  while (n < max) {
    const e = fromEnd ? expected[expected.length - 1 - n] : expected[n];
    const a = fromEnd ? actual[actual.length - 1 - n] : actual[n];
    if (e !== a) break;
    n++;
  }
  return n;
}

// Find the selector's quote in the index. Exact quote match; duplicate
// occurrences disambiguate by longest combined prefix+suffix agreement
// (ties: first occurrence). Not found -> null (caller marks orphaned).
export function locateSelector(index, selector) {
  if (!selector || !selector.quote) return null;
  const { quote, prefix = '', suffix = '' } = selector;
  const occurrences = [];
  let at = index.text.indexOf(quote);
  while (at !== -1) {
    occurrences.push(at);
    at = index.text.indexOf(quote, at + 1);
  }
  if (!occurrences.length) return null;
  let best = occurrences[0];
  let bestScore = -1;
  for (const occ of occurrences) {
    const actualPrefix = index.text.slice(Math.max(0, occ - prefix.length), occ);
    const actualSuffix = index.text.slice(occ + quote.length, occ + quote.length + suffix.length);
    const score = matchLen(prefix, actualPrefix, true) + matchLen(suffix, actualSuffix, false);
    if (score > bestScore) { bestScore = score; best = occ; }
  }
  return { start: best, end: best + quote.length };
}

// Map [start, end) offsets back to a DOM Range over the index's text nodes.
export function offsetsToRange(index, start, end) {
  if (!index.nodes.length || !(start >= 0) || !(end > start) || end > index.text.length) return null;
  const doc = index.root.ownerDocument;
  const nodeAt = (offset, isEnd) => {
    // The end boundary belongs to the node CONTAINING offset-1, so a span
    // ending exactly at a node border does not spill into the next node.
    const probe = isEnd ? offset - 1 : offset;
    let entry = index.nodes[0];
    for (const e of index.nodes) {
      if (e.start > probe) break;
      entry = e;
    }
    return { node: entry.node, offset: offset - entry.start };
  };
  const s = nodeAt(start, false);
  const e = nodeAt(end, true);
  const range = doc.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}
