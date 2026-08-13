'use strict';
// The decomposition acceptance line, as a test rather than a judgement call.
//
// The spec says app.js contains no view rendering outside its enumerated
// retentions. That line was claimed complete twice and failed both times,
// because both checks classified app.js by reading the section banner above a
// line rather than the code around it, and the banners had gone stale as
// sections moved out. This test classifies by ENCLOSING FUNCTION, which is
// what caught the two real misses.
//
// It fails in both directions on purpose. A new DOM-writing function in app.js
// fails it as unenumerated, which is the drift it exists to stop. Removing a
// retention's last DOM write also fails it, because the manifest then names a
// function that no longer renders and the list has quietly gone stale, which
// is exactly how the banners got wrong.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Every function in app.js allowed to write DOM, and the retention that covers
// it. Adding an entry here is amending the spec's retention list, so it should
// be as deliberate as that: a named reason, written down at the time.
const ALLOWED = {
  copyCode: 'retention 1: markdown rendering',
  showWorkspacePicker: 'retention 2: workspace picker',
  renderUpdateStrip: 'retention 3: update strip',
  EFFECT_EXECUTORS: 'retention 4: effect executors',
  updateWorkingBadge: 'retention 5: application shell',
  updateUnreadBadge: 'retention 5: application shell',
  initSidebarResize: 'retention 5: application shell',
  applyTheme: 'retention 5: application shell',
  // Not a retention and not rendering: esc builds a detached node purely to
  // escape text and never attaches it. It shows up in any createElement scan
  // and has wasted time in two previous passes, so it is named here.
  esc: 'not rendering: detached node used to escape text',
};

const DOM_WRITE = /\.innerHTML\s*=|createElement\(|insertAdjacentHTML|\.appendChild\(/;

function domWritersByFunction(src) {
  const lines = src.split('\n');
  const owners = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!DOM_WRITE.test(lines[i])) continue;
    // Walk back to the nearest column-0 function or const declaration. Column 0
    // matters: it is what makes this a top-level owner rather than a callback
    // nested inside one.
    let owner = '(top level)';
    for (let j = i; j >= 0; j--) {
      const l = lines[j];
      if (l.startsWith(' ') || l.startsWith('\t')) continue;
      const m = /^(?:async )?function (\w+)|^const (\w+)\s*=/.exec(l);
      if (m) { owner = m[1] || m[2]; break; }
    }
    if (!owners.has(owner)) owners.set(owner, []);
    owners.get(owner).push(i + 1);
  }
  return owners;
}

test('every DOM-writing function in app.js is an enumerated retention', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf-8');
  const owners = domWritersByFunction(src);

  assert.ok(owners.size >= 5, `sanity: found ${owners.size} DOM-writing functions`);

  const unenumerated = [...owners.entries()]
    .filter(([name]) => !(name in ALLOWED))
    .map(([name, lines]) => `${name} (app.js:${lines.join(', ')})`);

  assert.deepStrictEqual(
    unenumerated, [],
    'app.js renders outside its enumerated retentions; either move it into a view module or amend the spec with a named reason and add it here'
  );
});

test('the retention manifest has no entries that stopped rendering', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf-8');
  const owners = domWritersByFunction(src);
  const stale = Object.keys(ALLOWED).filter(name => !owners.has(name));
  assert.deepStrictEqual(
    stale, [],
    'these are listed as retentions but no longer write DOM in app.js; drop them here and from the spec'
  );
});
