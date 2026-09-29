'use strict';
// THE STYLE-DRIFT LINT'S TEST FIXTURE, AND HOW EVERY OTHER READER SKIPS IT.
//
// The lint reads files relative to the repository root, so its tests write a
// small stylesheet into public/styles for the length of one test. The name
// carries the writing process's id, so two runs at once (the gate in one
// window, a card's own run in another) never write, read or delete each
// other's file. And because a run elsewhere may have one on disk at any
// moment, everything that walks the stylesheets, the lint itself included,
// passes over any file with this shape.
const PREFIX = '__drift-fixture';
const SHAPE = /^__drift-fixture(-\d+)?\.css$/;

function driftFixtureName(pid = process.pid) { return `${PREFIX}-${pid}.css`; }
function isDriftFixture(name) { return SHAPE.test(String(name).split(/[\\/]/).pop()); }

module.exports = { driftFixtureName, isDriftFixture };
