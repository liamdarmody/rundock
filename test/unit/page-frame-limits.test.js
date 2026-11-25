'use strict';
// Every limit the page holds for the size of a frame it sends is the
// server's own: a page limit above it lets the server close the connection,
// one below it refuses what the server would read.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
// Loaded so that a tree without the server's limit fails on an assertion,
// never on the require.
const receive = (() => {
  try { return require('../../lib/attachments/receive.js'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /attachments[\\/]receive/.test(String(e.message))) return null;
    throw e;
  }
})();
const MAX_PAYLOAD = receive ? receive.MAX_PAYLOAD : undefined;

const ROOT = path.join(__dirname, '..', '..');

// Each page limit: the file that holds it and the constant's name.
const PAGE_LIMITS = [
  ['public/views/files.js', 'EDITOR_FRAME_LIMIT'],
  ['public/views/composer.js', 'COMPOSER_FRAME_LIMIT'],
];

// The value a constant is declared with, read from the shipped source.
function declared(file, name) {
  assert.ok(fs.existsSync(path.join(ROOT, file)), `the page no longer carries ${file}`);
  const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
  const opening = `const ${name} = `;
  const start = src.indexOf(opening);
  assert.ok(start !== -1, `${file} no longer declares ${name}`);
  assert.strictEqual(src.indexOf(opening, start + 1), -1, `${file} declares ${name} once`);
  return Number(src.slice(start + opening.length, src.indexOf(';', start)));
}

test('the server reads frames up to 28,000,000 bytes', () => {
  assert.strictEqual(MAX_PAYLOAD, 28000000);
});

test('every page limit on a frame equals the server\'s', () => {
  assert.strictEqual(typeof MAX_PAYLOAD, 'number', 'the server declares the largest frame it reads');
  for (const [file, name] of PAGE_LIMITS) assert.strictEqual(declared(file, name), MAX_PAYLOAD, `${name} in ${file}`);
});
