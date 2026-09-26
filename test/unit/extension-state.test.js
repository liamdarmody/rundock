'use strict';
// Extension view state, the server's half: one plain
// JSON object per extension per note, under .rundock/extension-state/, with
// every limit held here as well as in the host, and the whole of it removed
// when the extension is uninstalled.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readState, writeState, removeStateFor, stateFolderFor, STATE_ROOT, LIMITS,
} = require('../../lib/packages/extension-state.js');
const { RECORDS_PATH, RECORDS_SCHEMA, EXTENSIONS_ROOT } = require('../../lib/packages/extension-record.js');
const { planExtensionInstall, installExtension } = require('../../lib/packages/extension-install.js');
const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
const { applyImport } = require('../../lib/packages/import-apply.js');
const { planUninstall, applyUninstall } = require('../../lib/packages/package-uninstall.js');
const { makeTempDir } = require('../helpers/workspace.js');

let ws;
function install(name) {
  const file = path.join(ws, ...RECORDS_PATH.split('/'));
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).extensions : [];
  existing.push({ name, version: '1.0.0', source: { url: `https://github.com/example/${name}`, reference: 'v1.0.0' }, root: `${EXTENSIONS_ROOT}/${name}` });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: RECORDS_SCHEMA, extensions: existing }, null, 2));
  fs.mkdirSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), name), { recursive: true });
}
const fileFor = (ext, note) => path.join(ws, ...STATE_ROOT.split('/'), ext, `${crypto.createHash('sha256').update(note).digest('hex')}.json`);
const refusal = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected a refusal "${code}"`);
const snapshot = () => {
  const root = path.join(ws, '.rundock');
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
};

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-state-'));
  install('investment-partner');
  install('risk-board');
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

describe('where state lives, and whose it is', () => {
  test('one file per extension per note, named by the hash of the note path, holding the path and the state', () => {
    writeState(ws, 'investment-partner', 'Investments/Investment Dashboard.md', { 'rui.table.positions': { account: 180 } });
    const file = fileFor('investment-partner', 'Investments/Investment Dashboard.md');
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(kept.path, 'Investments/Investment Dashboard.md');
    assert.deepStrictEqual(kept.state, { 'rui.table.positions': { account: 180 } });
    assert.ok(!Number.isNaN(Date.parse(kept.updatedAt)));
    assert.deepStrictEqual(readState(ws, 'investment-partner', 'Investments/Investment Dashboard.md'), { 'rui.table.positions': { account: 180 } });
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)], 'written in place, no temporary file left');
  });

  test('another extension, or another note, reads nothing of it', () => {
    writeState(ws, 'investment-partner', 'A.md', { k: 1 });
    assert.strictEqual(readState(ws, 'risk-board', 'A.md'), null);
    assert.strictEqual(readState(ws, 'investment-partner', 'B.md'), null);
  });

  test('an extension that is not installed is refused, and nothing is written', () => {
    const before = snapshot();
    for (const name of ['not-installed', '../investment-partner', 'investment-partner/..', '']) {
      refusal(() => writeState(ws, name, 'A.md', { k: 1 }), 'not-installed');
      assert.strictEqual(readState(ws, name, 'A.md'), null);
    }
    assert.deepStrictEqual(snapshot(), before);
  });

  test('a note path must be a workspace-relative file path; the key is its normalised form', () => {
    for (const bad of ['', '/etc/passwd', '../outside.md', 'a/../../outside.md', 'C:\\x.md', 'a\\b.md', '.', 'a/']) {
      refusal(() => writeState(ws, 'investment-partner', bad, { k: 1 }), 'invalid-path');
    }
    writeState(ws, 'investment-partner', 'a//b/./c.md', { k: 1 });
    assert.deepStrictEqual(readState(ws, 'investment-partner', 'a/b/c.md'), { k: 1 }, 'one note, one key');
  });

  // The resolved folder is checked on disk, not only by name: a link planted
  // anywhere on the way would carry every write out of Rundock's folder.
  test('a state folder, state root or .rundock that is a link is refused, and nothing lands where it points', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-state-outside-'));
    try {
      const stateRoot = path.join(ws, ...STATE_ROOT.split('/'));
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.symlinkSync(outside, path.join(stateRoot, 'investment-partner'));
      refusal(() => writeState(ws, 'investment-partner', 'A.md', { k: 1 }), 'invalid-path');
      assert.strictEqual(readState(ws, 'investment-partner', 'A.md'), null);
      fs.unlinkSync(path.join(stateRoot, 'investment-partner'));
      fs.rmSync(stateRoot, { recursive: true });
      fs.symlinkSync(outside, stateRoot);
      refusal(() => writeState(ws, 'investment-partner', 'A.md', { k: 1 }), 'invalid-path');
      assert.deepStrictEqual(fs.readdirSync(outside), [], 'nothing written through the link');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a state file that is a link is never read', () => {
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-state-outside-')), 'other.json');
    fs.writeFileSync(outside, JSON.stringify({ path: 'A.md', state: { secret: 1 } }));
    writeState(ws, 'investment-partner', 'A.md', { k: 1 });
    const file = fileFor('investment-partner', 'A.md');
    fs.rmSync(file);
    fs.symlinkSync(outside, file);
    assert.strictEqual(readState(ws, 'investment-partner', 'A.md'), null);
    fs.rmSync(path.dirname(outside), { recursive: true, force: true });
  });
});

describe('plain JSON only, and the caps', () => {
  test('objects, arrays, strings, finite numbers, booleans and null are kept', () => {
    const state = { a: [1, 'two', true, null, { b: -2.5 }], c: {} };
    writeState(ws, 'investment-partner', 'A.md', state);
    assert.deepStrictEqual(readState(ws, 'investment-partner', 'A.md'), state);
  });

  test('anything JSON cannot carry is refused, naming where it is', () => {
    class Box { constructor() { this.v = 1; } }
    const cyclic = { a: {} };
    cyclic.a.back = cyclic;
    const cases = [
      [{ since: new Date() }, /a Date at since/],
      [{ m: new Map() }, /a Map at m/],
      [{ n: NaN }, /a number that is not finite at n/],
      [{ n: Infinity }, /a number that is not finite at n/],
      [{ f: () => 1 }, /a function at f/],
      [{ a: [1, undefined] }, /undefined at a\.1/],
      [{ b: new Box() }, /an object that is not plain at b/],
      [{ t: new Uint8Array(2) }, /a Uint8Array at t/],
      [cyclic, /a cycle at a\.back/],
      [{ big: 10n }, /a bigint at big/],
    ];
    for (const [value, reason] of cases) {
      assert.throws(() => writeState(ws, 'investment-partner', 'A.md', value), (e) => e.code === 'not-json' && reason.test(e.message), String(reason));
    }
    assert.strictEqual(readState(ws, 'investment-partner', 'A.md'), null, 'nothing written');
  });

  // The same shapes the host refuses, posted past it: the store is called
  // directly, as a bypassed or rewritten host would reach it, and each shape
  // is refused with the host's own words and writes nothing. JSON.stringify
  // would turn a hole into null and drop a named entry, so an array is walked
  // by index and any other key on it is refused.
  describe('every shape the host refuses is refused again past it, by name, with nothing written', () => {
    const holey = [1, , 2]; // eslint-disable-line no-sparse-arrays
    const named = Object.assign([1, 2], { extra: 3 });
    const symbolic = Object.assign([1], { [Symbol('s')]: 2 });
    class List extends Array {}
    const hidden = Object.defineProperty({ a: 1 }, 'toJSON', { value: () => ({ b: 2 }), enumerable: false });
    const getter = Object.defineProperty({}, 'g', { get: () => 1, enumerable: true });
    const cyclic = { a: {} };
    cyclic.a.back = cyclic;
    const cyclicArray = { a: [] };
    cyclicArray.a.push(cyclicArray.a);
    const cases = [
      [{ a: holey }, 'undefined at a.1'],
      [{ a: [1, undefined] }, 'undefined at a.1'],
      [{ a: new Array(3) }, 'undefined at a.0'],
      [{ a: named }, 'an array with named entries at a'],
      [{ a: symbolic }, 'an array with named entries at a'],
      [{ a: List.from([1]) }, 'an array that is not plain at a'],
      [{ s: new Set([1]) }, 'a Set at s'],
      [{ m: new Map([[1, 2]]) }, 'a Map at m'],
      [{ r: /x/ }, 'a RegExp at r'],
      [{ b: new Blob(['x']) }, 'a Blob at b'],
      [{ since: new Date(0) }, 'a Date at since'],
      [{ t: new Uint8Array(2) }, 'a Uint8Array at t'],
      [{ t: new Float64Array(2) }, 'a Float64Array at t'],
      [{ t: new ArrayBuffer(2) }, 'an ArrayBuffer at t'],
      [cyclic, 'a cycle at a.back'],
      [cyclicArray, 'a cycle at a.0'],
      [{ n: NaN }, 'a number that is not finite at n'],
      [{ n: [Infinity] }, 'a number that is not finite at n.0'],
      [{ n: -Infinity }, 'a number that is not finite at n'],
      [{ o: hidden }, 'an entry JSON would not keep as it is at o.toJSON'],
      [{ o: getter }, 'an entry JSON would not keep as it is at o.g'],
      [{ o: { [Symbol('s')]: 1 } }, 'a symbol key at o'],
    ];
    for (const [state, reason] of cases) {
      test(reason, () => {
        writeState(ws, 'investment-partner', 'Kept.md', { k: 1 });
        const before = snapshot();
        assert.throws(() => writeState(ws, 'investment-partner', 'A.md', state),
          (e) => e.code === 'not-json' && e.message === `the view state is not plain JSON: ${reason}`, reason);
        assert.deepStrictEqual(snapshot(), before, 'nothing written');
        assert.strictEqual(readState(ws, 'investment-partner', 'A.md'), null);
      });
    }
  });

  // A top-level value with no enumerable keys is not an empty state: each is
  // refused as the nested case is, and the note's stored state is left as it
  // was rather than removed.
  describe('a top-level shape with no enumerable keys is refused, and the kept state stays', () => {
    class Empty {}
    const cases = [
      [() => new Date(0), 'a Date'],
      [() => new Map(), 'a Map'],
      [() => new Set([1]), 'a Set'],
      [() => /x/, 'a RegExp'],
      [() => new Blob([]), 'a Blob'],
      [() => ({ [Symbol('s')]: 1 }), 'a symbol key'],
      [() => Object.defineProperty({}, 'toJSON', { value: () => ({ b: 2 }), enumerable: false }), 'an entry JSON would not keep as it is at toJSON'],
      [() => Object.defineProperty({}, 'a', { value: 1, enumerable: false }), 'an entry JSON would not keep as it is at a'],
      [() => new Empty(), 'an object that is not plain'],
      [() => new Uint8Array(0), 'a Uint8Array'],
    ];
    for (const [make, reason] of cases) {
      test(`top level: ${reason}`, () => {
        writeState(ws, 'investment-partner', 'A.md', { keep: 1 });
        const before = snapshot();
        assert.throws(() => writeState(ws, 'investment-partner', 'A.md', make()),
          (e) => e.code === 'not-json' && e.message === `the view state is not plain JSON: ${reason}`, reason);
        assert.deepStrictEqual(snapshot(), before, 'the stored file is untouched');
        assert.deepStrictEqual(readState(ws, 'investment-partner', 'A.md'), { keep: 1 });
      });
    }

    for (const [label, make] of [['a plain empty object', () => ({})], ['an empty object with no prototype', () => Object.create(null)], ['null', () => null]]) {
      test(`${label} still removes the note's state`, () => {
        writeState(ws, 'investment-partner', 'A.md', { keep: 1 });
        writeState(ws, 'investment-partner', 'A.md', make());
        assert.strictEqual(fs.existsSync(fileFor('investment-partner', 'A.md')), false);
        assert.strictEqual(readState(ws, 'investment-partner', 'A.md'), null);
      });
    }
  });

  test('the state is an object: an array, a string or a number is refused', () => {
    for (const value of [[1], 'x', 3, true]) refusal(() => writeState(ws, 'investment-partner', 'A.md', value), 'not-object');
  });

  test('16 levels deep is kept; 17 is refused', () => {
    const nest = (n) => { let v = {}; for (let i = 1; i < n; i += 1) v = { v }; return v; };
    writeState(ws, 'investment-partner', 'A.md', nest(16));
    refusal(() => writeState(ws, 'investment-partner', 'A.md', nest(17)), 'too-deep');
  });

  test('64 KB of serialised state is kept; one byte more is refused', () => {
    assert.strictEqual(LIMITS.noteBytes, 65536);
    const sized = (bytes) => ({ s: 'x'.repeat(bytes - Buffer.byteLength('{"s":""}')) });
    writeState(ws, 'investment-partner', 'A.md', sized(65536));
    refusal(() => writeState(ws, 'investment-partner', 'A.md', sized(65537)), 'too-large');
    const multi = { s: '€'.repeat(21845) }; // 3 bytes each in UTF-8: 65,543 bytes serialised
    refusal(() => writeState(ws, 'investment-partner', 'B.md', multi), 'too-large');
  });

  test('each extension is capped in total, by bytes and by notes; a write that shrinks or removes is always allowed', () => {
    assert.deepStrictEqual([LIMITS.extensionBytes, LIMITS.extensionNotes], [1024 * 1024, 1000]);
    // Counted as stored on disk: each file is its state plus about 63 bytes
    // of path and time, so two notes of 100 fit in 600 and a third of 200
    // does not.
    const small = { noteBytes: 65536, extensionBytes: 600, extensionNotes: 3 };
    const at = (n) => ({ s: 'x'.repeat(n) });
    writeState(ws, 'investment-partner', 'A.md', at(100), small);
    writeState(ws, 'investment-partner', 'B.md', at(100), small);
    refusal(() => writeState(ws, 'investment-partner', 'C.md', at(200), small), 'over-limit');
    writeState(ws, 'investment-partner', 'C.md', at(10), small);
    refusal(() => writeState(ws, 'investment-partner', 'D.md', at(1), small), 'over-limit');
    writeState(ws, 'investment-partner', 'A.md', at(5), small);
    writeState(ws, 'investment-partner', 'B.md', null, small);
    assert.strictEqual(readState(ws, 'investment-partner', 'B.md'), null, 'removed');
    writeState(ws, 'risk-board', 'A.md', at(250), small);
  });

  test('an extension already over its total may still shrink a note, and may not grow one', () => {
    const at = (n) => ({ s: 'x'.repeat(n) });
    writeState(ws, 'investment-partner', 'A.md', at(100));
    writeState(ws, 'investment-partner', 'B.md', at(100));
    // The limit now sits below what is kept, as after a hand-copied folder.
    const tight = { noteBytes: 65536, extensionBytes: 200, extensionNotes: 1000 };
    writeState(ws, 'investment-partner', 'A.md', at(50), tight);
    assert.deepStrictEqual(readState(ws, 'investment-partner', 'A.md'), at(50));
    refusal(() => writeState(ws, 'investment-partner', 'A.md', at(60), tight), 'over-limit');
  });

  test('null, or an empty object, removes the note\'s state', () => {
    writeState(ws, 'investment-partner', 'A.md', { k: 1 });
    writeState(ws, 'investment-partner', 'A.md', {});
    assert.strictEqual(fs.existsSync(fileFor('investment-partner', 'A.md')), false);
    writeState(ws, 'investment-partner', 'A.md', null);
  });
});

describe('reading never hands a view what it could not have written', () => {
  test('a missing, corrupt, oversized or wrongly shaped file reads as null', () => {
    writeState(ws, 'investment-partner', 'A.md', { k: 1 });
    const file = fileFor('investment-partner', 'A.md');
    for (const text of ['{ not json', JSON.stringify({ path: 'A.md', state: [1] }), JSON.stringify({ path: 'A.md', state: { s: 'x'.repeat(70000) } }),
      JSON.stringify({ path: 'A.md', state: JSON.parse('{"a":' + '{"a":'.repeat(20) + '1' + '}'.repeat(21)) })]) {
      fs.writeFileSync(file, text);
      assert.strictEqual(readState(ws, 'investment-partner', 'A.md'), null, text.slice(0, 30));
    }
  });
});

describe('uninstall removes the state, and nothing else', () => {
  // An extension leaves only with its package, so the removal is proved
  // through the package uninstall: two packages, each with a view, installed
  // as a person would install them.
  function packaged() {
    const root = makeTempDir('rundock-state-pkg-');
    for (const name of ['investment-partner', 'risk-board']) {
      const src = makeTempDir('rundock-state-src-');
      const files = {
        [`.claude/agents/${name}.md`]: `---\nname: ${name}\n---\n\n${name}.\n`,
        'rundock.json': JSON.stringify({ name, version: '1.0.0', extension: { entry: 'view/index.html', match: `*.${name}` } }),
        'view/index.html': '<main></main>',
      };
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(src, ...rel.split('/'))), { recursive: true });
        fs.writeFileSync(path.join(src, ...rel.split('/')), content);
      }
      const id = `https://github.com/example/${name}`;
      const plan = buildPlan(root, src, { id, reference: 'v1.0.0' });
      applyImport(root, src, decide(plan, Object.fromEntries(plan.items.map((i) => [i.id, 'add']))),
        { receipt: { now: '2026-09-01T09:00:00.000Z', run: Buffer.from(id).toString('hex').slice(-6) } });
      installExtension(root, src, planExtensionInstall(root, src, { url: id, reference: 'v1.0.0' }));
    }
    return root;
  }

  test('uninstalling one extension removes its state folder; the other\'s state and the rest of .rundock stay', () => {
    fs.rmSync(ws, { recursive: true, force: true });
    ws = packaged();
    writeState(ws, 'investment-partner', 'A.md', { k: 1 });
    writeState(ws, 'risk-board', 'A.md', { k: 2 });
    fs.writeFileSync(path.join(ws, '.rundock', 'pins.json'), '["A.md"]');
    const before = snapshot();
    const id = 'https://github.com/example/investment-partner';
    const plan = planUninstall(ws, id);
    applyUninstall(ws, id, plan.key);
    assert.strictEqual(fs.existsSync(path.join(ws, ...STATE_ROOT.split('/'), 'investment-partner')), false);
    assert.deepStrictEqual(readState(ws, 'risk-board', 'A.md'), { k: 2 });
    // What went is the package's own: its extension, its record, its
    // receipts and its state. Every other byte under .rundock is as it was.
    const gone = [`extension-state${path.sep}investment-partner${path.sep}`, `extensions${path.sep}investment-partner${path.sep}`,
      ...plan.receipts.map((r) => path.relative('.rundock', r))];
    const after = snapshot();
    for (const [file, text] of Object.entries(before)) {
      if (file === 'extensions.json' || gone.some((g) => file === g || file.startsWith(g))) continue;
      assert.strictEqual(after[file], text, `${file} untouched`);
    }
    assert.deepStrictEqual(Object.keys(after).filter((f) => !(f in before)), [], 'nothing new was written');
  });

  test('removeStateFor refuses a name that is not a plain extension name', () => {
    for (const bad of ['..', '../x', '', 'a/b']) refusal(() => removeStateFor(ws, bad), 'invalid-name');
  });

  // For the package uninstall's one transaction: the folder it must remove,
  // named absolutely, whether or not the extension ever wrote any state.
  test('stateFolderFor names the one folder an uninstall removes, and refuses anything else', () => {
    assert.strictEqual(stateFolderFor(ws, 'risk-board'), path.join(ws, '.rundock', 'extension-state', 'risk-board'));
    for (const bad of ['..', '../x', '', 'a/b', 'A']) refusal(() => stateFolderFor(ws, bad), 'invalid-name');
  });
});
