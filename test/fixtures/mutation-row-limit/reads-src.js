'use strict';
// A node:test file over the throwaway repository's src.js, which the fixture
// harness mutates. It goes red when the guard line is broken and stays green
// for any other change, and it keeps a copy of what it read, so a test can
// check which version of the file each row's suite saw.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(process.cwd(), 'src.js'), 'utf8');
if (process.env.MUTATION_FIXTURE_PIDS) {
  fs.writeFileSync(path.join(process.env.MUTATION_FIXTURE_PIDS, `seen.${process.pid}`), src);
}
test('the guard holds', () => {
  assert.match(src, /const GUARD = true;/);
});
