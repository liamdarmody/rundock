'use strict';
// Unit: how a file's name is presented in search results.
//
// The rule: every file, markdown included, is shown under its real filename,
// extension and all, exactly as the file tree shows it. The two panes are
// usually visible at the same time, and the same file must not carry two
// names on one screen.
//
// This DELIBERATELY REVERSES an earlier rule that hid `.md` in search
// ("almost every file is a note and its extension never told two of them
// apart"). That reasoning is sound per-pane and was overridden anyway:
// consistency between two simultaneously visible panes beats per-pane
// tidiness. Recorded here as a reversal so the argument is not re-run from
// scratch a fourth time; this function is the single written form of the
// naming rule, and the tree side simply renders names untouched.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { displayTitle } = require('../../search.js');

describe('displayTitle', () => {
  test('shows .md, so the tree and search agree on one name per file', () => {
    assert.strictEqual(displayTitle('notes.md'), 'notes.md');
    assert.strictEqual(displayTitle('pricing-strategy.md'), 'pricing-strategy.md');
    assert.strictEqual(displayTitle('REPORT.MD'), 'REPORT.MD');
  });

  test('shows every other extension, unchanged from before', () => {
    // One name, five types: the extension is what tells the rows apart.
    const titles = ['pdf', 'html', 'png', 'jpg', 'gif']
      .map(e => displayTitle(`board-pack-q3.${e}`));
    assert.strictEqual(new Set(titles).size, 5,
      'five files sharing a name must produce five distinct titles');
    assert.strictEqual(displayTitle('board-pack-q3.pdf'), 'board-pack-q3.pdf');
  });

  test('takes the basename, so a nested path does not leak into the title', () => {
    assert.strictEqual(displayTitle('notes/board-packs/report.pdf'), 'report.pdf');
    assert.strictEqual(displayTitle('notes/board-packs/report.md'), 'report.md');
  });

  test('leaves files with no extension and dotfiles alone', () => {
    assert.strictEqual(displayTitle('Makefile'), 'Makefile');
    assert.strictEqual(displayTitle('.gitignore'), '.gitignore');
    assert.strictEqual(displayTitle('.env'), '.env');
    assert.strictEqual(displayTitle('.md'), '.md');
  });

  test('handles multiple dots without eating part of the name', () => {
    assert.strictEqual(displayTitle('archive.tar.gz'), 'archive.tar.gz');
    assert.strictEqual(displayTitle('notes.v2.md'), 'notes.v2.md');
    assert.strictEqual(displayTitle('.env.md'), '.env.md');
  });

  test('never returns an empty title for any input that names a file', () => {
    const inputs = [
      'notes.md', '.md', '.gitignore', 'Makefile', 'a.md', 'a.pdf',
      'x/y/z.md', 'x/y/.md', 'archive.tar.gz', 'REPORT.MD', '.env.md',
    ];
    for (const input of inputs) {
      const out = displayTitle(input);
      assert.ok(typeof out === 'string' && out.length > 0,
        `displayTitle(${JSON.stringify(input)}) produced ${JSON.stringify(out)}`);
    }
  });

  test('behaves identically under Windows path rules', () => {
    // Tree and index paths are built with explicit forward slashes on every
    // platform, and Windows accepts both separators. Pinned so the rule
    // cannot quietly diverge on the platform CI does not integration-test.
    const path = require('node:path');
    const under = (P, rel) => P.basename(rel);
    const cases = [
      'packs/board-pack-q3.pdf', 'notes/sub/report.MD', 'Makefile',
      '.gitignore', 'archive.tar.gz', 'notes.v2.md', 'x/y/.md',
    ];
    for (const c of cases) {
      assert.strictEqual(under(path.win32, c), under(path.posix, c),
        `${c} must present the same way regardless of platform path rules`);
      assert.strictEqual(displayTitle(c), under(path.posix, c),
        `${c} must match the reference rule`);
    }
  });

  test('is total: junk input yields a string rather than throwing', () => {
    // It runs on every indexed row and every result. A throw here would take
    // out indexing or the whole result list.
    for (const junk of [undefined, null, '', 123, {}, []]) {
      assert.strictEqual(typeof displayTitle(junk), 'string',
        `displayTitle(${JSON.stringify(junk)}) must return a string`);
    }
  });
});
