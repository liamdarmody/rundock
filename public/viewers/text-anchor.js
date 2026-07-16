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

// Map a DOM Range to [start, end) offsets in the index. Text-node boundary
// containers take the fast path; element containers (triple-click,
// selectNodeContents) resolve by comparing boundary points against the
// index's text nodes. Anything unmappable (foreign document, collapsed
// span) returns null: callers treat that as "no usable selection".
export function rangeToOffsets(index, range) {
  const doc = index.root.ownerDocument;
  const boundaryOffset = (which) => {
    const container = which === 'start' ? range.startContainer : range.endContainer;
    const offset = which === 'start' ? range.startOffset : range.endOffset;
    const entry = index.nodes.find((e) => e.node === container);
    if (entry) return entry.start + offset;
    const boundary = range.cloneRange();
    boundary.collapse(which === 'start');
    const probe = doc.createRange();
    // < 0: the probe point sits before the boundary.
    const cmpAt = (node, off) => {
      probe.setStart(node, off);
      probe.collapse(true);
      return probe.compareBoundaryPoints(0 /* START_TO_START */, boundary);
    };
    for (const e of index.nodes) {
      const len = e.node.nodeValue.length;
      if (cmpAt(e.node, len) < 0) continue;      // node ends before the boundary
      if (cmpAt(e.node, 0) >= 0) return e.start; // boundary at/before node start
      let lo = 0, hi = len;                      // boundary inside this node
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cmpAt(e.node, mid) < 0) lo = mid + 1; else hi = mid;
      }
      return e.start + lo;
    }
    return index.text.length;
  };
  try {
    const start = boundaryOffset('start');
    const end = boundaryOffset('end');
    if (start == null || end == null || end <= start) return null;
    return { start, end };
  } catch {
    return null; // e.g. a range from another document
  }
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
