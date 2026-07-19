'use strict';
// Integration: live external refresh. When a client has a file open (read_file),
// the server watches it and pushes `file_changed` with the new content whenever
// the file changes on disk (an agent, Obsidian, another Rundock window). The
// watcher follows the client's open file and never re-sends identical content.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');

before(async () => {
  await h.boot({ workspaceOpts: { files: { 'note.md': 'original\n', 'other.md': 'other\n' } } });
});
after(async () => h.shutdown());

describe('live external refresh', () => {
  test('a change to the open file pushes file_changed with the new content', async () => {
    const c = await h.connect();
    try {
      c.send({ type: 'read_file', path: 'note.md' });
      await c.waitFor(m => m.type === 'file_content' && m.path === 'note.md', { label: 'file_content' });
      fs.writeFileSync(path.join(h.workspaceDir, 'note.md'), 'changed by an agent\n');
      const changed = await c.waitFor(m => m.type === 'file_changed' && m.path === 'note.md', { label: 'file_changed' });
      assert.strictEqual(changed.msg.content, 'changed by an agent\n');
    } finally {
      c.close();
    }
  });

  test('re-writing identical content does not push (no needless refresh)', async () => {
    const c = await h.connect();
    try {
      fs.writeFileSync(path.join(h.workspaceDir, 'note.md'), 'stable\n');
      c.send({ type: 'read_file', path: 'note.md' });
      await c.waitFor(m => m.type === 'file_content', { label: 'file_content' });
      const since = c.messages.length;
      fs.writeFileSync(path.join(h.workspaceDir, 'note.md'), 'stable\n'); // same bytes
      await assert.rejects(
        () => c.waitFor(m => m.type === 'file_changed', { since, timeout: 1600, label: 'no-op' }),
        'identical content must not push a file_changed');
    } finally {
      c.close();
    }
  });

  test('opening another file moves the watcher off the first', async () => {
    const c = await h.connect();
    try {
      c.send({ type: 'read_file', path: 'note.md' });
      await c.waitFor(m => m.type === 'file_content' && m.path === 'note.md', { label: 'first open' });
      c.send({ type: 'read_file', path: 'other.md' });
      await c.waitFor(m => m.type === 'file_content' && m.path === 'other.md', { label: 'second open' });
      const since = c.messages.length;
      // A change to the FIRST file is no longer watched.
      fs.writeFileSync(path.join(h.workspaceDir, 'note.md'), 'late change to note\n');
      await assert.rejects(
        () => c.waitFor(m => m.type === 'file_changed' && m.path === 'note.md', { since, timeout: 1600, label: 'stale watch' }),
        'the old file must no longer be watched');
      // But a change to the CURRENT file still pushes.
      fs.writeFileSync(path.join(h.workspaceDir, 'other.md'), 'other changed\n');
      const changed = await c.waitFor(m => m.type === 'file_changed' && m.path === 'other.md', { since, label: 'current watch' });
      assert.strictEqual(changed.msg.content, 'other changed\n');
    } finally {
      c.close();
    }
  });
});
