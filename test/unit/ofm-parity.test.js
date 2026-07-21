// Obsidian markdown parity: the fixture corpus (test/fixtures/ofm/) IS the
// audit artifact and the regression suite. One file per construct family,
// covering Obsidian's syntax reference. The hard bar for EVERY construct,
// including ones the editor does not render: opening and saving must change
// zero bytes. A rendering gap is acceptable and gets carded; corruption
// never is.
//
// Two lists:
//  - PASSING families assert byte-exact round-trip (regressions fail here).
//  - KNOWN_CORRUPTING families are the open findings, each carded
//    in the backlog. Their tests assert the corruption STILL EXISTS, so
//    fixing one fails its test loudly and the family graduates to the
//    passing list. Silence never means safety.
//
// The render-verdict half of the parity matrix is judged by inspection and
// recorded in the audit document; this suite pins the byte-safety half.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roundTrip } from '../helpers/editor-harness.js';

const CORPUS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ofm');
const files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.md')).sort();

// Known corruption findings, by family -> defect.
// Every entry has a backlog card; fix the serialization, watch its test
// fail, then move the family out of this map.
const KNOWN_CORRUPTING = {
  'blockquotes.md': 'nested blockquote reflows: `> > inner` gains a bare `>` line and moves',
  'emphasis-extended.md': 'nested strikethrough+bold mangles: ~~struck **bold**~~ -> broken mark nesting',
  'escapes.md': 'escaped non-CommonMark syntax loses its backslash: \\== becomes a live highlight',
};

describe('OFM parity corpus: byte-exact round-trip for every construct family', () => {
  assert.ok(files.length >= 20, `corpus present (${files.length} families)`);

  for (const file of files.filter((f) => !(f in KNOWN_CORRUPTING))) {
    test(`${file} round-trips byte-for-byte`, async () => {
      const src = fs.readFileSync(path.join(CORPUS_DIR, file), 'utf-8');
      const out = await roundTrip(src);
      assert.equal(out, src, `${file}: the editor changed bytes it does not own`);
    });
  }
});

describe('OFM parity corpus: known corruptions (carded; a fix must graduate the family)', () => {
  for (const [file, defect] of Object.entries(KNOWN_CORRUPTING)) {
    test(`${file} still corrupts: ${defect}`, async () => {
      const src = fs.readFileSync(path.join(CORPUS_DIR, file), 'utf-8');
      const out = await roundTrip(src);
      assert.notEqual(out, src,
        `${file} now round-trips byte-for-byte. Move it OUT of KNOWN_CORRUPTING into the passing list and close its backlog card.`);
    });
  }
});
