'use strict';
// The pull request text check (scripts/check-pr-text.js): a title and a body
// scanned with the same rules as a push. The private term is invented.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'check-pr-text.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-text-'));
const list = path.join(dir, 'denylist.txt');
fs.writeFileSync(list, '[person]\nZorblat\n');
const env = { ...process.env, RUNDOCK_PRIVATE_DENYLIST: list };
delete env.CI;

function run(title, body) {
  const file = path.join(dir, 'body.md');
  fs.writeFileSync(file, body);
  return spawnSync(process.execPath, [SCRIPT, '--title', title, '--body-file', file], { env, encoding: 'utf8' });
}

test('clean text passes', () => {
  const r = run('Save the note on blur', 'Saves the note when the editor loses focus.\n');
  assert.strictEqual(r.status, 0, r.stderr);
});

test('a private term in the body blocks, masked, with its line', () => {
  const r = run('Save the note', 'Line one.\nThanks to Zorblat for the report.\n');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /PR body:2 +\[private person\]/);
  assert.ok(!r.stderr.includes('Zorblat'), r.stderr);
});

test('the title is scanned too', () => {
  const r = run(`Fix ${['mcp', 'frobnic', 'list'].join('__')} names`, 'Body.\n');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /PR title:1 +\[MCP tool name/);
});

test('a session link in the body blocks', () => {
  const r = run('Title', `https://claude.ai/code/${'session'}_01abc\n`);
  assert.strictEqual(r.status, 1);
});

test('a missing body file is an error, not a pass', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--title', 'x', '--body-file', path.join(dir, 'nope.md')], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
});
