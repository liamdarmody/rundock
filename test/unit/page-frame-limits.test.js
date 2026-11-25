'use strict';
// Every limit the page holds for the size of a frame it sends is the
// server's own: a page limit above it lets the server close the connection,
// one below it refuses what the server would read.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { MAX_PAYLOAD } = require('../../lib/attachments/receive.js');

const ROOT = path.join(__dirname, '..', '..');

// Each page limit: the file that holds it and the constant's name.
const PAGE_LIMITS = [
  ['public/views/files.js', 'EDITOR_FRAME_LIMIT'],
];

// The value a constant is declared with, read from the shipped source.
function declared(file, name) {
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
  for (const [file, name] of PAGE_LIMITS) assert.strictEqual(declared(file, name), MAX_PAYLOAD, `${name} in ${file}`);
});
