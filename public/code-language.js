'use strict';
// Language resolution for fenced code blocks. Pure decision logic, extracted
// from the marked renderer so it is unit-testable under node --test (the
// vendored highlight.js is UMD and loads in both the browser and Node).
//
// Why this exists: highlightAuto() over the full language set mislabels
// prose as VB.NET (its loose, English-like grammar wins on plain sentences),
// so unlabelled plain-text blocks rendered as code in a language they are
// not. Unlabelled blocks now auto-detect over a curated subset that excludes
// prose-greedy grammars and includes markdown, and a detection is accepted
// only when its relevance clears a threshold; anything below renders as
// escaped plaintext honestly labelled "text".
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.resolveCodeLanguage = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // Curated auto-detect subset: the languages agents actually emit, minus
  // grammars that win on prose (vbnet, basic, vim-script-like). Filtered
  // against the loaded build at call time, so entries missing from the
  // vendored bundle are simply ignored.
  const AUTODETECT_SUBSET = [
    'javascript', 'typescript', 'python', 'json', 'yaml', 'bash', 'shell',
    'markdown', 'xml', 'css', 'sql', 'java', 'go', 'rust', 'ruby', 'php',
    'c', 'cpp', 'csharp', 'diff', 'ini', 'powershell', 'dockerfile',
    'makefile', 'kotlin', 'swift',
  ];

  // Minimum highlightAuto relevance to accept a detection on an unlabelled
  // block. Tuned against the fixture corpus in test/unit/code-language.test.js
  // (measured on the vendored build): plain prose scores 2, plain lists and
  // log lines score 4, while real content starts at 6 (json) and runs to 9
  // (javascript/python). 5 splits the two populations cleanly.
  const AUTODETECT_RELEVANCE_MIN = 5;

  // highlightAuto relevance ACCUMULATES with length, so the flat floor above is
  // not enough on its own: a long prose block (e.g. a LinkedIn draft) piles up
  // incidental matches and clears 5 while remaining obvious prose (it scored as
  // Rust). Relevance DENSITY separates them cleanly regardless of length: on the
  // vendored build, prose tops out around 0.015 relevance/char however long it
  // runs, while real code floors around 0.048. 0.03 (about 3 per 100 chars)
  // splits the two with margin. A detection must clear BOTH the floor and this.
  const AUTODETECT_RELEVANCE_DENSITY_MIN = 0.03;

  // Language hints that mean "this is plain text": first-class, never
  // auto-detected, rendered escaped and labelled "text".
  const PLAIN_HINTS = new Set(['plaintext', 'text', 'plain', 'txt']);

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Decide how a fenced code block renders.
   * @param {string|undefined} lang - the fence's language hint, if any
   * @param {string} text - the raw block text
   * @param {object|undefined} hljs - the highlight.js instance (may be absent)
   * @param {number} [maxAutoDetect] - skip auto-detection above this length
   * @returns {{ html: string, label: string }} highlighted (or escaped) HTML
   *          plus the header label ('' means no label)
   */
  function resolveCodeLanguage(lang, text, hljs, maxAutoDetect = 20000) {
    const hint = String(lang || '').trim().toLowerCase();

    // Explicit plain-text hints are first-class: escaped, labelled "text".
    if (PLAIN_HINTS.has(hint)) {
      return { html: escapeHtml(text), label: 'text' };
    }

    // An explicit known hint always wins (unchanged behaviour).
    if (hint && hljs && hljs.getLanguage(hint)) {
      return {
        html: hljs.highlight(text, { language: hint }).value,
        label: hljs.getLanguage(hint).name || hint,
      };
    }

    // Unknown hint, no hljs, or oversized block: escaped, hint as label.
    if (hint || !hljs || text.length > maxAutoDetect) {
      return { html: escapeHtml(text), label: hint || '' };
    }

    // Unlabelled: auto-detect over the curated subset, gate on relevance AND
    // relevance density (guards against long prose accumulating past the floor).
    const subset = AUTODETECT_SUBSET.filter(l => hljs.getLanguage(l));
    const result = hljs.highlightAuto(text, subset);
    const density = text.length ? result.relevance / text.length : 0;
    if (result.language
        && result.relevance >= AUTODETECT_RELEVANCE_MIN
        && density >= AUTODETECT_RELEVANCE_DENSITY_MIN) {
      return {
        html: result.value,
        label: (hljs.getLanguage(result.language) || {}).name || result.language,
      };
    }
    return { html: escapeHtml(text), label: 'text' };
  }

  resolveCodeLanguage.AUTODETECT_SUBSET = AUTODETECT_SUBSET;
  resolveCodeLanguage.AUTODETECT_RELEVANCE_MIN = AUTODETECT_RELEVANCE_MIN;
  resolveCodeLanguage.AUTODETECT_RELEVANCE_DENSITY_MIN = AUTODETECT_RELEVANCE_DENSITY_MIN;
  return resolveCodeLanguage;
}));
