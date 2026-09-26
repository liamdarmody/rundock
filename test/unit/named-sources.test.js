'use strict';
// Named sources: the grammar (public/named-sources-model.js) and the server
// resolver and write (lib/workspace/named-sources.js). Every link and canary
// is under this run's own temporary root.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const model = require('../../public/named-sources-model.js');
const { resolveSources, saveSource, REASONS } = require('../../lib/workspace/named-sources.js');
const { REASONS: FILE_REASONS } = require('../../lib/workspace/extension-file.js');
const { makeTempDir } = require('../helpers/workspace.js');

const CANARY = 'CANARY-NOT-A-REAL-KEY';

function world(names, extraNote = '') {
  const root = makeTempDir('sources-');
  const ws = path.join(root, 'ws');
  const outside = path.join(root, 'outside');
  const w = (rel, text) => { const p = path.join(ws, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.csv'), CANARY);
  w('.env', `KEY=${CANARY}`);
  w('notes/holdings.csv', 'ticker,qty\nAAA,10\n');
  w('notes/limits.csv', 'limit,value\nmax,0.2\n');
  w('notes/unnamed.csv', CANARY);
  w('notes/hidden-src.txt', CANARY);
  fs.linkSync(path.join(ws, 'notes', 'hidden-src.txt'), path.join(ws, 'notes', 'hard.csv'));
  fs.symlinkSync(path.join(outside, 'secret.csv'), path.join(ws, 'notes', 'link-out.csv'));
  fs.symlinkSync(path.join(ws, '.env'), path.join(ws, 'notes', 'link-hidden.csv'));
  fs.symlinkSync(outside, path.join(ws, 'mirror'));
  w('dash.md', `---\nportfolio-dashboard: true\nsources:\n${names.map((n) => `  - ${n}`).join('\n')}\n---\n# Dashboard\n${extraNote}`);
  return { root, ws, outside };
}
const byPath = (r) => Object.fromEntries(r.sources.map((s) => [s.path, s]));

describe('the list a note writes', () => {
  test('block and flow lists, quotes, and the Obsidian link spelling of an exact path', () => {
    assert.deepStrictEqual(model.listedSources('---\nsources:\n  - a.csv\n  - "b.csv"\n  - "[[c/d.csv]]"\n---\n').names, ['a.csv', 'b.csv', 'c/d.csv']);
    assert.deepStrictEqual(model.listedSources('---\nsources: [a.csv, b.csv]\n---\n').names, ['a.csv', 'b.csv']);
    assert.deepStrictEqual(model.listedSources('no frontmatter'), { names: [], error: null });
    assert.match(model.listedSources('---\nsources: a.csv\n---\n').error, /list/);
  });

  test('more than twelve names is refused as a whole', () => {
    const many = Array.from({ length: 13 }, (_, i) => `n${i}.csv`);
    assert.match(model.listedSources(`---\nsources:\n${many.map((n) => `  - ${n}`).join('\n')}\n---\n`).error, /at most 12/);
  });

  test('each rule a name alone can break is refused by name, never by target', () => {
    const cases = {
      '/etc/hosts': /relative/, '~/x': /relative/, 'C:/x': /relative/, 'a\\b': /forward slashes/,
      'a/./b': /step out/, 'a/../b': /step out/, 'a//b': /empty segment/, 'notes/*.csv': /patterns/,
      'a.md|alias': /aliases/, 'a.md#h': /headings/, '.env': /hidden/, 'notes/.x/y.csv': /hidden/,
      'a\u0000b': /control/,
    };
    for (const [name, rule] of Object.entries(cases)) assert.match(model.nameRefusal(name), rule, name);
    assert.strictEqual(model.nameRefusal('notes/holdings.csv'), null);
  });

  test('sameSources: a body edit keeps the list; any change to it does not', () => {
    const note = '---\nsources:\n  - a.csv\n---\nbody\n';
    assert.strictEqual(model.sameSources(note, note.replace('body', 'edited body')), true);
    assert.strictEqual(model.sameSources(note, note.replace('a.csv', 'b.csv')), false);
    assert.strictEqual(model.sameSources(note, note.replace('  - a.csv\n', '  - a.csv\n  - b.csv\n')), false);
    assert.strictEqual(model.sameSources('plain', '---\nsources: [x.csv]\n---\nplain'), false, 'planting a list where there was none is a change');
  });

  test('the total cap is the host\'s init cap', async () => {
    const host = await import('../../public/extension-host.js');
    assert.strictEqual(model.MAX_TOTAL_CHARS, host.MAX_INIT_CONTENT_CHARS);
  });
});

describe('resolveSources', () => {
  test('hands exactly the listed files that resolve, each as the name written and its text, nothing else', () => {
    const { ws, outside } = world(['notes/holdings.csv', '"[[notes/limits.csv]]"']);
    const r = resolveSources(ws, 'dash.md');
    assert.deepStrictEqual(r, { ok: true, sources: [
      { path: 'notes/holdings.csv', content: 'ticker,qty\nAAA,10\n' },
      { path: 'notes/limits.csv', content: 'limit,value\nmax,0.2\n' },
    ] });
    const text = JSON.stringify(r);
    assert.ok(!text.includes(ws) && !text.includes(outside));
  });

  test('every refused kind is refused by its rule, and no canary or real path is in the answer', () => {
    const { ws, outside } = world(['notes/link-out.csv', 'notes/link-hidden.csv', 'mirror/secret.csv', 'notes/hard.csv',
      'notes', 'notes/missing.csv', 'notes/holdings.csv', 'notes/holdings.csv', '.env', '../outside/secret.csv']);
    const r = byPath(resolveSources(ws, 'dash.md'));
    assert.strictEqual(r['notes/link-out.csv'].refused, FILE_REASONS.linked);
    assert.strictEqual(r['notes/link-hidden.csv'].refused, FILE_REASONS.linked);
    assert.strictEqual(r['mirror/secret.csv'].refused, FILE_REASONS.linked, 'a symlinked folder');
    assert.strictEqual(r['notes/hard.csv'].refused, FILE_REASONS.hardLink);
    assert.strictEqual(r.notes.refused, FILE_REASONS.notFile, 'a folder');
    assert.strictEqual(r['notes/missing.csv'].refused, FILE_REASONS.missing);
    assert.match(r['.env'].refused, /hidden/);
    assert.match(r['../outside/secret.csv'].refused, /step out/);
    const all = resolveSources(ws, 'dash.md');
    assert.deepStrictEqual(all.sources.filter((s) => s.path === 'notes/holdings.csv').map((s) => Object.keys(s)[1]), ['content', 'refused']);
    assert.strictEqual(all.sources[7].refused, REASONS.duplicate);
    const text = JSON.stringify(all);
    assert.ok(!text.includes(CANARY) && !text.includes(ws) && !text.includes(outside));
  });

  test('the note itself is refused under any spelling, identity by device and inode', () => {
    const { ws } = world(['dash.md', 'DASH.md']);
    const r = resolveSources(ws, 'dash.md');
    assert.strictEqual(r.sources[0].refused, REASONS.self);
    // On a case-insensitive disk the variant is the same file; on a
    // case-sensitive one it does not exist. Either way it is never handed.
    assert.ok(r.sources[1].refused === REASONS.self || r.sources[1].refused === FILE_REASONS.missing, r.sources[1].refused);
  });

  test('identity is device and inode, not spelling: a different name for the same file is the note itself', () => {
    // Forced, so it holds on any disk: a second file, spelled differently,
    // that the filesystem reports as the note's device and inode. Were
    // identity the path's spelling, this name would be handed over.
    const { ws } = world(['Dash-alias.md']);
    fs.writeFileSync(path.join(ws, 'Dash-alias.md'), 'CANARY-ALIAS');
    const realStat = fs.statSync;
    const noteStat = realStat(path.join(ws, 'dash.md'));
    fs.statSync = (p, ...rest) => (String(p).endsWith(`${path.sep}Dash-alias.md`) ? noteStat : realStat(p, ...rest));
    try {
      const r = resolveSources(ws, 'dash.md');
      assert.deepStrictEqual(r.sources, [{ path: 'Dash-alias.md', refused: REASONS.self }]);
    } finally { fs.statSync = realStat; }
  });

  test('on a case-insensitive disk, a case variant of the note is the note itself', (t) => {
    const { ws } = world(['DASH.md']);
    if (!fs.existsSync(path.join(ws, 'DASH.md'))) return t.skip('this disk is case-sensitive; the forced-identity test above covers it');
    const r = resolveSources(ws, 'dash.md');
    assert.deepStrictEqual(r.sources, [{ path: 'DASH.md', refused: REASONS.self }], 'refused as the note, never handed');
  });

  test('a source past the total cap is refused, and the note counts toward it', () => {
    const { ws } = world(['notes/holdings.csv', 'notes/big.csv']);
    fs.writeFileSync(path.join(ws, 'notes', 'big.csv'), 'x'.repeat(model.MAX_TOTAL_CHARS));
    const r = byPath(resolveSources(ws, 'dash.md'));
    assert.strictEqual(typeof r['notes/holdings.csv'].content, 'string');
    assert.strictEqual(r['notes/big.csv'].refused, REASONS.overCap);
  });

  test('the note itself is held to the same rule: a linked note resolves to nothing', () => {
    const { ws } = world(['notes/holdings.csv']);
    fs.symlinkSync(path.join(ws, 'dash.md'), path.join(ws, 'linked-dash.md'));
    const r = resolveSources(ws, 'linked-dash.md');
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.sources, []);
    assert.match(r.reason, /linked/);
  });
});

describe('saveSource', () => {
  test('writes only a listed, resolving source, byte for byte', () => {
    const { ws } = world(['notes/holdings.csv']);
    assert.strictEqual(saveSource(ws, 'dash.md', 'notes/holdings.csv', 'ticker,qty\nAAA,11\n'), null);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'notes', 'holdings.csv'), 'utf8'), 'ticker,qty\nAAA,11\n');
  });

  test('an unlisted, refused or hidden name is refused and nothing on disk changes', () => {
    const { ws, outside } = world(['notes/holdings.csv', 'notes/link-out.csv']);
    for (const name of ['notes/unnamed.csv', '.env', 'notes/link-out.csv', 'NOTES/HOLDINGS.CSV', 'notes/./holdings.csv', '../outside/secret.csv']) {
      assert.ok(saveSource(ws, 'dash.md', name, 'PWNED'), name);
    }
    assert.strictEqual(fs.readFileSync(path.join(ws, 'notes', 'unnamed.csv'), 'utf8'), CANARY);
    assert.strictEqual(fs.readFileSync(path.join(ws, '.env'), 'utf8'), `KEY=${CANARY}`);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.csv'), 'utf8'), CANARY);
  });

  test('a source swapped for a link after it was handed out is not written through', () => {
    const { ws, outside } = world(['notes/holdings.csv']);
    assert.strictEqual(resolveSources(ws, 'dash.md').sources[0].content, 'ticker,qty\nAAA,10\n');
    fs.rmSync(path.join(ws, 'notes', 'holdings.csv'));
    fs.symlinkSync(path.join(outside, 'secret.csv'), path.join(ws, 'notes', 'holdings.csv'));
    assert.strictEqual(saveSource(ws, 'dash.md', 'notes/holdings.csv', 'PWNED'), FILE_REASONS.linked);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.csv'), 'utf8'), CANARY);
  });

  test('a name the resolver refused now is refused for the write too, even where the file rule alone would allow it', () => {
    const { ws } = world(['dash.md', 'notes/holdings.csv']);
    const note = fs.readFileSync(path.join(ws, 'dash.md'), 'utf8');
    assert.strictEqual(saveSource(ws, 'dash.md', 'dash.md', note.replace('# Dashboard', '# Edited')), REASONS.self);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'dash.md'), 'utf8'), note);
  });

  test('a source that is itself a note cannot have its list changed through the write', () => {
    const { ws } = world(['notes/sub.md']);
    fs.writeFileSync(path.join(ws, 'notes', 'sub.md'), '---\nsources:\n  - notes/limits.csv\n---\nsub\n');
    const widened = '---\nsources:\n  - notes/unnamed.csv\n---\nsub\n';
    assert.strictEqual(saveSource(ws, 'dash.md', 'notes/sub.md', widened), model.CHANGED_LIST_REASON);
    assert.match(fs.readFileSync(path.join(ws, 'notes', 'sub.md'), 'utf8'), /notes\/limits\.csv/);
    assert.strictEqual(saveSource(ws, 'dash.md', 'notes/sub.md', '---\nsources:\n  - notes/limits.csv\n---\nsub edited\n'), null,
      'an edit that keeps the list is allowed');
  });
});
