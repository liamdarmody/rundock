'use strict';
// A test file that gives itself a made-up home under the temporary directory,
// as Rundock's tests do, and starts a turn, so the answer-file guard comes to
// watch the shell startup files in that home. Whether the preload that
// refuses the account's own home lets the run pass is the whole question.
// Never part of `npm test`: test/unit/prove-tmp-outside-home.test.js runs it
// the way the prove workflow runs a test as its test user.
const { home } = require('../../helpers/made-up-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireAnswerFileGuard } = require('../../../lib/workspace/answer-file-guard.js');

test('a turn in a made-up home under the temporary directory', () => {
  assert.ok(home.startsWith(fs.realpathSync(os.tmpdir()) + path.sep), `${home} is under the temporary directory`);
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);
  const turn = acquireAnswerFileGuard(workspace, () => {}, { intervalMs: 60 * 1000 });
  turn.release();
});
