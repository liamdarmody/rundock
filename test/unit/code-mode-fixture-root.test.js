'use strict';
// The Code-mode suites need a fixture folder outside every temp folder and git
// working tree. Without one they skip locally, saying why. Under CI they must
// fail instead: node --test reports a skipped suite as green, and these suites
// carry the evidence the permission rules rest on.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fx = require('../helpers/code-mode-fixture.js');

// A base that can never hold the fixture: a folder inside the temp folder.
const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-root-'));
after(() => fs.rmSync(tempBase, { recursive: true, force: true }));

describe('with no folder to build the fixture in', () => {
  test('outside CI the suites skip, with the reason', () => {
    for (const env of [{}, { CI: '' }, { CI: 'false' }, { CI: '0' }]) {
      const r = fx.outsideTempRoot({ env, candidates: [tempBase] });
      assert.ok(r.skip && /RUNDOCK_TEST_OUTSIDE_TEMP_ROOT/.test(r.skip), JSON.stringify(env));
    }
  });

  test('under CI they fail rather than skip', () => {
    for (const env of [{ CI: 'true' }, { CI: '1' }]) {
      assert.throws(() => fx.outsideTempRoot({ env, candidates: [tempBase] }), /fails rather than skips/, JSON.stringify(env));
    }
  });
});

test('with a usable folder, the fixture is built there', () => {
  const r = fx.outsideTempRoot({ env: { RUNDOCK_TEST_OUTSIDE_TEMP_ROOT: process.env.RUNDOCK_TEST_OUTSIDE_TEMP_ROOT } });
  if (r.skip) return; // this machine has no such folder; the cases above cover what happens then
  try {
    assert.ok(fs.statSync(r.dir).isDirectory());
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});
