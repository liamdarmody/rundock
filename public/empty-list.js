'use strict';
// Recovers the original text of an ordered list that has no content, so a
// reply which is only a number renders as that number.
//
// Pure decision logic, extracted from the marked renderer so it is
// unit-testable under node --test, following code-language.js.
//
// Why this exists: `4471.` is valid ordered-list syntax, so markdown parses it
// to a list whose only item is empty. The reply then exists solely as the list
// marker, and the message bubble's fixed list `padding-left` cannot scale to an
// arbitrarily wide marker, so a five-character number is drawn outside the
// bubble entirely. Markdown is behaving correctly; the intent was never a list.
//
// The fix is here rather than in CSS because padding cannot be made to fit
// every marker width, and moving the marker inside the content flow would
// change wrapping for genuine multi-line lists. A high-numbered GENUINE list
// (`4471. real item`) is deliberately left to the padding guard: it is a real
// list and must keep rendering as one.
//
// Deliberately scoped to ordered lists. A bullet marker is narrow enough that
// it never escapes the bubble, so there is no bug to fix there, and a lone `-`
// is more plausibly deliberate than a lone number.
//
// The failure that matters is the false positive: rewriting a genuine list to a
// paragraph would silently destroy formatting. So the test is "every item is
// empty", not "any item is empty", and anything unrecognised returns null and
// is left exactly as it was.
//
// Total by design: it runs on every list the renderer sees, so junk in yields
// null rather than taking down a whole message.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.emptyOrderedListText = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * @param {object} token a marked `list` token
   * @returns {string|null} the text to render as a paragraph, or null to leave
   *   the list exactly as it is. Null is always the safe answer.
   */
  function emptyOrderedListText(token) {
    if (!token || typeof token !== 'object') return null;
    if (token.type !== 'list' || !token.ordered) return null;

    const items = token.items;
    if (!Array.isArray(items) || items.length === 0) return null;

    // Every item, not any: a list with even one item of content is a real list.
    // An item whose text is missing rather than empty counts as content, so an
    // unfamiliar token shape errs towards leaving the list alone.
    const allEmpty = items.every(
      (item) => item && typeof item.text === 'string' && item.text.trim() === ''
    );
    if (!allEmpty) return null;

    // `raw` is the source that produced the list, which is exactly what the
    // user typed and therefore exactly what they should see back.
    if (typeof token.raw !== 'string') return null;
    // The result is a paragraph, so newlines between the bare markers collapse
    // to spaces. This only affects input that was already degenerate; the point
    // is that the text is not silently dropped.
    const text = token.raw.replace(/\s*\n\s*/g, ' ').trim();
    return text || null;
  }

  return emptyOrderedListText;
}));
