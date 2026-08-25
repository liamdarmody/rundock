'use strict';
// What an agent's colour is allowed to be, in one place.
//
// WHY A RULE AND NOT AN ESCAPER
//
// An agent's colour is document text. `lib/agents/discovery.js` copies it out
// of an agent file's frontmatter with a `key: value` line scanner that strips
// a wrapping pair of quotes and validates nothing else, and agent files are
// written BY agents: a response can carry a RUNDOCK:SAVE_AGENT block, and the
// handler validates the slug and writes the body verbatim. So the value that
// ends up in `style="background:…"` is chosen by whoever wrote that file.
//
// Escaping it stops one thing: a value ENDING the attribute and opening an
// event handler after it. It does nothing about a value that stays inside the
// attribute and is still CSS. `red;background-image:url(https://…)` breaks no
// quote and needs no handler, and in an app with no Content-Security-Policy
// (markdown-render.js records why there is none yet, and what would have to
// change first) that is a request leaving the machine on render.
//
// A colour has a small grammar, so it can be judged rather than escaped, which
// is the renderer's answer for a link destination: decide what the value is
// allowed to BE and refuse everything else. `isNavigableHref` is the same idea
// one type along.
//
// WHAT PASSES, and why each shape is here rather than tidied away:
//
//   #rgb #rgba #rrggbb #rrggbbaa   what Rundock itself writes. The palette in
//                                  lib/agents/discovery.js is eight hex
//                                  literals and every auto-assigned colour is
//                                  one of them.
//   a var() reference             the fallback the call sites already used,
//                                  and the only correct way to name a design
//                                  token from here (see docs/DESIGN.md).
//                                  Written without the literal syntax because
//                                  test/unit/token-references.test.js reads
//                                  every var() in public/ and asks tokens.css
//                                  for a declaration behind it, which a token
//                                  named in an example does not have.
//   a bare name                    `rebeccapurple`, `tomato`. Letters only, so
//                                  a name cannot carry punctuation.
//   rgb() rgba() hsl() hsla()      an agent file may reasonably carry one, and
//                                  refusing them would be a behaviour change
//                                  wearing a security fix's clothes.
//
// THE PROPERTY THAT MATTERS, if this is ever widened: the pattern is anchored
// at both ends, admits no `;`, no `(` outside the four notations named, and no
// character that needs escaping in an attribute. A value that passes therefore
// cannot carry a second declaration, cannot open a `url()`, and has nothing in
// it for an escaper to do. Widening it is fine; widening it past that is not.
//
// A REFUSED COLOUR IS NOT AN ERROR. It becomes the fallback the caller names,
// which is the same value a missing colour already got. An agent file with a
// nonsense colour renders in the accent or the idle token and says nothing,
// exactly as it did before this module existed. Refusing loudly would put a
// security message in front of a person over a typo in a hex code.
//
// Pure and side-effect-free, so `require()` works under node --test and the
// tests exercise the real rule rather than a copy of it. public/chat-markup.js
// carries its own copy of this pattern for the reason recorded there, and
// test/unit/agent-colour.test.js asserts the two agree on every input in a
// shared corpus, so "expected to stay in step" is checked rather than hoped.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockAgentColour = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const COLOUR = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]+|var\(\s*--[a-zA-Z0-9_-]+\s*\)|(?:rgb|rgba|hsl|hsla)\(\s*[0-9a-zA-Z.,%/\s-]+\s*\))$/;

  /**
   * A colour safe to write into a style attribute, or the fallback.
   *
   * @param {unknown} value the colour as the agent file wrote it
   * @param {string} [fallback] what a missing or refused colour becomes
   */
  function safeColour(value, fallback) {
    const safe = fallback === undefined ? 'var(--accent)' : fallback;
    // ONLY A STRING IS A COLOUR, and this line is not defensive tidying. The
    // pattern admits a bare name, so anything stringifying to letters passes
    // it: `false` becomes "false", which is letters, which is a colour by the
    // grammar and nonsense by every other reading. Frontmatter parsing yields
    // strings, so a non-string here is a caller mistake, and the fallback is
    // the right answer to one.
    if (typeof value !== 'string') return safe;
    const s = value.trim();
    return s && COLOUR.test(s) ? s : safe;
  }

  return { safeColour, COLOUR };
}));
