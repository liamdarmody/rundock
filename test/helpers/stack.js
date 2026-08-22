'use strict';
// Which function a call came from, matched as a FRAME rather than as a
// substring of the stack.
//
// WHY THIS EXISTS, because the obvious version is one character shorter and
// wrong. A test that makes a wired dependency throw has to say WHICH call site
// it means, and the natural way to say it is
// `new Error().stack.includes('beginRun')`. That is a substring test, so it
// also matches every function whose name merely STARTS with the one asked for:
// `beginRun` matches `beginRunRecord`.
//
// When the technique was first written there was no such pair in this file, so
// the ambiguity did not exist. The pair arrived later, in a change that had no
// reason to look at these tests, which is the shape of the problem: the code
// that breaks the selection is not the code the selection is about.
//
// The failure is silent in both directions. The fake fires at a call site the
// test did not mean, or it stops firing at all and the test passes having
// proved nothing, which is why every caller here asserts that its throw
// actually happened before concluding anything from the result.
//
// A V8 frame renders the name as `    at name (file:line:col)`, or with a
// receiver as `at Object.name (...)`. Requiring the space and the opening
// bracket after the name is what makes one name unable to be a prefix of
// another. `fn` is a plain identifier by contract, not a pattern.
function calledFrom(fn) {
  return new RegExp(`(?:^|[\\s.])${fn} \\(`, 'm').test(new Error().stack);
}

module.exports = { calledFrom };
