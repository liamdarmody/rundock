'use strict';
// The page's half of the extension file rule: it never decides, it forwards
// what the server said (lib/workspace/extension-file.js), and it reads no
// answer as a refusal. Two small pieces are cut from the shipped source and
// driven here, so the code under test is the code that runs: how an embed
// reads the server's header, and whether a document gets region drawers.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FILES_SRC = fs.readFileSync(path.join(ROOT, 'public', 'views', 'files.js'), 'utf8');
const REGIONS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'editor', 'plugins', 'regions.js'), 'utf8');

function cut(src, re, name) {
  const m = src.match(re);
  assert.ok(m, `the source no longer carries ${name}`);
  return m[0];
}

const LINKED = 'a linked file, or a file in a linked folder, is never handed to an extension';

describe('an embed reads the server\'s answer from its header', () => {
  const embedText = new Function('fetch', 'EXTENSION_UNCHECKED_REASON',
    `${cut(FILES_SRC, /function embedText\(path\) \{[\s\S]*?\n\}/, 'embedText')}; return embedText;`);
  const reply = (header) => () => Promise.resolve({
    ok: true,
    headers: { get: (name) => (name === 'X-Rundock-Extension-Refusal' ? header : null) },
    text: () => Promise.resolve('a,b\n'),
  });

  test("an explicit 'none' clears it", async () => {
    assert.deepStrictEqual(await embedText(reply('none'), 'unchecked')('notes/a.csv'), { text: 'a,b\n', refusal: null });
  });
  test('a stated rule refuses it, in the rule\'s own words', async () => {
    assert.deepStrictEqual(await embedText(reply(encodeURIComponent(LINKED)), 'unchecked')('notes/a.csv'), { text: 'a,b\n', refusal: LINKED });
  });
  test('no header at all is a refusal, never permission', async () => {
    assert.strictEqual((await embedText(reply(null), 'unchecked')('notes/a.csv')).refusal, 'unchecked');
  });
});

describe('a document the server refused has no region drawers', () => {
  const drawerForOf = (win, currentFilePath) => new Function('window', 'currentFilePath',
    `${cut(REGIONS_SRC, /function drawerFor\(language\) \{[\s\S]*?\n\}/, 'drawerFor')}; return drawerFor;`)(win, currentFilePath);
  const registry = { drawerFor: (language) => ({ extension: 'diagrams', language }) };

  test('a cleared document gets its drawer', () => {
    const drawerFor = drawerForOf({ rundockRendererRegistry: registry, rundockExtensionRefusalFor: () => null }, 'notes/plan.md');
    assert.deepStrictEqual(drawerFor('Mermaid'), { extension: 'diagrams', language: 'mermaid' });
  });
  test('a refused document gets none', () => {
    const drawerFor = drawerForOf({ rundockRendererRegistry: registry, rundockExtensionRefusalFor: () => LINKED }, 'notes/linked.md');
    assert.strictEqual(drawerFor('mermaid'), null);
  });
  test('with no way to ask, a document gets none', () => {
    const drawerFor = drawerForOf({ rundockRendererRegistry: registry }, 'notes/plan.md');
    assert.strictEqual(drawerFor('mermaid'), null);
  });
});
