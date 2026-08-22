'use strict';
// Builds the REAL renderer from public/markdown-render.js, wired to the exact
// dependencies the browser gets.
//
// marked matters here. lib/http-router.js serves
// node_modules/marked/lib/marked.umd.js at /marked.min.js, and that UMD file
// does not export usefully through require(): loaded as CommonJS it hands back
// an empty object, because its wrapper only populates the global when no
// `module` is in scope. Requiring the package entry instead would test a
// different build from the one the app runs. So it is loaded exactly as a
// <script> tag loads it: evaluated with no module/exports/define in scope,
// against a fake global that then carries `marked`.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function loadBrowserMarked() {
  const src = fs.readFileSync(path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf8');
  const globalObj = {};
  const load = new Function('globalThis', 'self', 'module', 'exports', 'define', src);
  load.call(globalObj, globalObj, globalObj, undefined, undefined, undefined);
  return globalObj.marked;
}

const hljs = require(path.join(ROOT, 'public', 'vendor', 'highlight', 'highlight.min.js'));
const resolveCodeLanguage = require(path.join(ROOT, 'public', 'code-language.js'));
const emptyOrderedListText = require(path.join(ROOT, 'public', 'empty-list.js'));
const { createMarkdownRenderer, attachWikilinkHandler, attachCodeCopyHandler } = require(path.join(ROOT, 'public', 'markdown-render.js'));

/** Build a renderer with the browser's dependency set. */
function makeRenderer() {
  return createMarkdownRenderer({
    marked: loadBrowserMarked(),
    hljs,
    resolveCodeLanguage,
    emptyOrderedListText,
  });
}

module.exports = { makeRenderer, loadBrowserMarked, attachWikilinkHandler, attachCodeCopyHandler };
