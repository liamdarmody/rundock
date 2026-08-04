'use strict';
// Unit: how a file's name is presented in search results.
//
// Search used to strip the extension from every file, so a set of files that
// differed only by type collapsed into identical rows: the same text, the same
// generic icon, no type anywhere. Having a report as HTML, PDF, PNG, JPG and
// GIF is ordinary, and the list gave no way to tell which row was which.
//
// The rule: markdown is the default format for notes, so `.md` appears on
// almost every file and never distinguishes one from another. It is hidden.
// Every other extension is shown, because it is the only thing separating
// those five files.
//
// This function is the single definition of that rule. It exists as one shared
// function precisely because the old stripping logic was written in three
// separate places, and they drifted.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { displayTitle } = require('../../search.js');

describe('displayTitle', () => {
  test('hides .md, because it appears on almost every file', () => {
    assert.strictEqual(displayTitle('notes.md'), 'notes');
    assert.strictEqual(displayTitle('pricing-strategy.md'), 'pricing-strategy');
  });

  test('shows every other extension, because that is what tells files apart', () => {
    // The exact case this change exists for: one name, five types.
    assert.strictEqual(displayTitle('board-pack-q3.pdf'), 'board-pack-q3.pdf');
    assert.strictEqual(displayTitle('board-pack-q3.html'), 'board-pack-q3.html');
    assert.strictEqual(displayTitle('board-pack-q3.png'), 'board-pack-q3.png');
    assert.strictEqual(displayTitle('board-pack-q3.jpg'), 'board-pack-q3.jpg');
    assert.strictEqual(displayTitle('board-pack-q3.gif'), 'board-pack-q3.gif');

    const titles = ['pdf', 'html', 'png', 'jpg', 'gif']
      .map(e => displayTitle(`board-pack-q3.${e}`));
    assert.strictEqual(new Set(titles).size, 5,
      'five files sharing a name must produce five distinct titles; that is the whole point');
  });

  test('takes the basename, so a nested path does not leak into the title', () => {
    assert.strictEqual(displayTitle('notes/board-packs/report.pdf'), 'report.pdf');
    assert.strictEqual(displayTitle('notes/board-packs/report.md'), 'report');
  });

  test('matches the extension case-insensitively', () => {
    // A case-insensitive filesystem will hand us either spelling, and .MD is
    // still markdown. Getting this wrong shows `REPORT.MD` to some users only.
    assert.strictEqual(displayTitle('REPORT.MD'), 'REPORT');
    assert.strictEqual(displayTitle('notes.Md'), 'notes');
    assert.strictEqual(displayTitle('REPORT.PDF'), 'REPORT.PDF',
      'a shown extension keeps its original case; only the comparison is insensitive');
  });

  test('leaves a file with no extension alone', () => {
    assert.strictEqual(displayTitle('Makefile'), 'Makefile');
    assert.strictEqual(displayTitle('LICENSE'), 'LICENSE');
  });

  test('treats a dotfile as a name, not as an extension', () => {
    // path.extname('.gitignore') is '' by design. Stripping naively here would
    // produce an empty title and an invisible row.
    assert.strictEqual(displayTitle('.gitignore'), '.gitignore');
    assert.strictEqual(displayTitle('.env'), '.env');
    assert.strictEqual(displayTitle('.md'), '.md');
  });

  test('handles multiple dots without eating part of the name', () => {
    assert.strictEqual(displayTitle('archive.tar.gz'), 'archive.tar.gz');
    assert.strictEqual(displayTitle('notes.v2.md'), 'notes.v2');
    assert.strictEqual(displayTitle('.env.md'), '.env');
  });

  test('never returns an empty title for any input', () => {
    // An empty title renders as a blank, unclickable-looking row. No input
    // that names a real file may produce one.
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
    // platform, and Windows accepts both separators. This pins that, so the
    // rule cannot quietly diverge on the one platform CI does not run the
    // integration suite on.
    const path = require('node:path');
    const HIDDEN = '.md';
    const under = (P, rel) => {
      const b = P.basename(rel);
      const e = P.extname(b);
      if (!e) return b;
      if (e.toLowerCase() !== HIDDEN) return b;
      return P.basename(b, e) || b;
    };
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
