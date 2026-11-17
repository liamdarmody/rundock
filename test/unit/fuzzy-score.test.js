'use strict';
// public/fuzzy-score.js is the one fuzzy scorer: the server's search and the
// editor's wikilink suggestions must rank a name the same way. The scoring
// itself is pinned by test/unit/search-core.test.js; this file pins that
// there is exactly one copy of it and that the browser can load it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

test('the search index and the browser module export the same scorer', () => {
  const shared = require('../../public/fuzzy-score.js');
  const search = require('../../search.js');
  assert.strictEqual(typeof shared.fuzzyScore, 'function');
  assert.strictEqual(search.fuzzyScore, shared.fuzzyScore);
});

test('search.js no longer carries a scorer of its own', () => {
  const src = fs.readFileSync(path.join(ROOT, 'search.js'), 'utf8');
  assert.ok(!src.includes('function fuzzyScore'), 'search.js defines fuzzyScore again');
});

test('loaded as a plain script, the module sets a browser global', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'fuzzy-score.js'), 'utf8');
  const sandbox = { self: {} };
  vm.runInNewContext(src, sandbox);
  assert.strictEqual(typeof sandbox.self.RundockFuzzy.fuzzyScore, 'function');
  assert.ok(sandbox.self.RundockFuzzy.fuzzyScore('road', 'Roadmap') > 0);
  assert.strictEqual(sandbox.self.RundockFuzzy.fuzzyScore('', 'Roadmap'), null);
});

test('the page loads the module as a script', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const at = html.indexOf('<script src="/fuzzy-score.js"></script>');
  assert.ok(at > 0, 'index.html does not load /fuzzy-score.js');
});
