'use strict';
// The one fuzzy title scorer, shared by the server's search (search.js) and
// the browser (the editor's wikilink suggestions). Kept in one file so a name
// ranks the same way in the Cmd+K palette and in the note editor.
//
// Same UMD pattern as the other client modules: required in Node, a global
// (RundockFuzzy) in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockFuzzy = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Fzf-style subsequence scorer for the title/name layer (file names,
   * conversation titles, agent/skill names: all small in-memory corpora).
   * Content-level search stays lexical in FTS5; fuzziness applies to titles
   * only (titles only).
   *
   * Returns a numeric score (higher = better) or null when `needle` is not an
   * in-order subsequence of `haystack`. Scoring favours: consecutive runs,
   * word-boundary starts, early matches, and shorter haystacks.
   */
  function fuzzyScore(needle, haystack) {
    if (!needle || !haystack) return null;
    const n = String(needle).toLowerCase();
    const h = String(haystack).toLowerCase();
    if (n.length > h.length) return null;

    // Exact substring: strong score, earlier + tighter is better.
    // Acronym pass: needle matching the word initials ("cs" → "Conversation
    // Search") outranks any mid-word substring hit. Checked before the
    // substring branch so multi-word-initial intent wins.
    const initials = h.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(w => w[0]).join('');
    if (n.length >= 2 && initials.includes(n)) {
      return 140 + n.length * 4 - Math.min(initials.indexOf(n), 10);
    }

    const sub = h.indexOf(n);
    if (sub !== -1) {
      let score = 100 + n.length * 4;
      if (sub === 0 || /[^\p{L}\p{N}]/u.test(h[sub - 1])) score += 30; // boundary start
      score -= Math.min(sub, 20); // earlier is better
      score -= Math.min(h.length - n.length, 20) * 0.5; // tighter is better
      return score;
    }

    // Subsequence walk with consecutive-run and boundary bonuses.
    let score = 0, hi = 0, prevMatch = -2, matched = 0;
    for (let ni = 0; ni < n.length; ni++) {
      const ch = n[ni];
      let found = -1;
      while (hi < h.length) {
        if (h[hi] === ch) { found = hi; hi++; break; }
        hi++;
      }
      if (found === -1) return null;
      matched++;
      let charScore = 1;
      if (found === prevMatch + 1) charScore += 4; // consecutive
      if (found === 0 || /[^\p{L}\p{N}]/u.test(h[found - 1])) charScore += 6; // word boundary
      charScore -= Math.min(found, 30) * 0.05; // early bias
      score += charScore;
      prevMatch = found;
    }
    if (matched !== n.length) return null;
    score -= Math.min(h.length - n.length, 40) * 0.2; // shorter haystack bias
    return score;
  }

  return { fuzzyScore };
}));
