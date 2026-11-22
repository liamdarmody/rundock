'use strict';
// The TAP the prove workflow's classifier is tested on holds no absolute path.
//
// A run prints paths into its TAP: a failing test's location and stack, and
// a file that fails to load. The capture script makes every path to the
// repository relative before it writes a capture, plain or as a file URL, so
// a capture says the same thing on every machine and names nobody's home.
// These tests hold the committed captures and the rewrite to that.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { CASES, relative } = require('../fixtures/prove/capture.js');

const ROOT = path.join(__dirname, '..', '..');
const TAP = path.join(__dirname, '..', 'fixtures', 'prove', 'tap');
// Written in pieces so this file holds neither prefix whole.
const HOMES = [['', 'Users', ''].join('/'), ['', 'home', ''].join('/')];
const homeIn = (text) => HOMES.find((h) => text.includes(h)) || null;

test('the home check sees a home directory in either form', () => {
  assert.strictEqual(homeIn(`at ${HOMES[0]}someone/repo/test/a.js:1:1`), HOMES[0]);
  assert.strictEqual(homeIn(`at file://${HOMES[1]}someone/repo/test/a.js:1:1`), HOMES[1]);
  assert.strictEqual(homeIn('at test/a.js:1:1'), null);
});

test('no captured run holds a home directory', () => {
  const files = fs.readdirSync(TAP).filter((f) => f.endsWith('.tap'));
  // Every case the capture script takes, and the three runs of the test that
  // varies, so a capture that went missing is not passed by being absent.
  assert.strictEqual(files.length, CASES.length + 3, `the captures are all here (found ${files.length})`);
  for (const file of files) {
    const found = homeIn(fs.readFileSync(path.join(TAP, file), 'utf8'));
    assert.strictEqual(found, null, `${file} holds ${found}`);
  }
});

test('the capture makes the repository path relative, plain and as a file URL', () => {
  const sep = path.sep;
  const text = [
    `at ${pathToFileURL(ROOT).href}/test/a.js:1:1`,
    `at ${path.resolve(ROOT)}${sep}test${sep}a.js:2:2`,
    `cwd ${path.resolve(ROOT)}`,
  ].join('\n');
  assert.strictEqual(relative(text), ['at test/a.js:1:1', `at test${sep}a.js:2:2`, 'cwd .'].join('\n'));
});

test('the capture rewrites the real path of the repository too', () => {
  const real = fs.realpathSync(ROOT);
  assert.strictEqual(relative(`at ${pathToFileURL(real).href}/test/a.js:3:3 and ${real}${path.sep}b.js`),
    `at test/a.js:3:3 and b.js`);
});
