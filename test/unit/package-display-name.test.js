'use strict';
// A package may name itself: rundock.json's optional `displayName`, held to
// one rule, carried on the extension record, the roster and the receipt, and
// shown on the install card, the Packages page and the Extensions page, with
// the title-cased slug wherever it gives none.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { readExtensionManifest, classifySnapshot, readPackageDisplayName } = require('../../lib/packages/extension-manifest.js');
const { planExtensionInstall, installExtension } = require('../../lib/packages/extension-install.js');
const { listExtensions } = require('../../lib/packages/extension-registry.js');
const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
const { applyImport } = require('../../lib/packages/import-apply.js');
const { listReceipts } = require('../../lib/packages/extension-manage.js');
const { packageCards } = require('../../lib/packages/package-state.js');
const install = require('../../public/packages-install-model.js');
const { makeTempDir } = require('../helpers/workspace.js');

function put(root, rel, content) {
  const absolute = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}
function extension(extra = {}) {
  const root = makeTempDir('display-name-');
  put(root, 'rundock.json', JSON.stringify({ name: 'csv-table', version: '1.0.0', extension: { entry: 'view/index.html', match: '*.csv' }, ...extra }));
  put(root, 'view/index.html', '<main></main>');
  return root;
}

describe('the manifest rule', () => {
  test('an optional, trimmed, plain name is read; absent reads as none', () => {
    assert.strictEqual(readExtensionManifest(extension({ displayName: '  CSV Viewer  ' })).displayName, 'CSV Viewer');
    assert.ok(!('displayName' in readExtensionManifest(extension())));
  });

  test('a malformed name is refused by name, never cleaned', () => {
    for (const bad of ['', '   ', 'x'.repeat(61), '<b>CSV</b>', 'CSV\nViewer', 'Tab\there', 42, null, ['CSV']]) {
      assert.throws(() => readExtensionManifest(extension({ displayName: bad })), /displayName must be plain text of 1 to 60 characters/, JSON.stringify(bad));
    }
    assert.strictEqual(readExtensionManifest(extension({ displayName: 'x'.repeat(60) })).displayName.length, 60, 'sixty is allowed');
  });

  test('a package of agents and skills is held to the same rule', () => {
    const root = makeTempDir('display-name-content-');
    put(root, 'rundock.json', JSON.stringify({ name: 'lean-team', version: '1.0.0', displayName: '<i>Lean</i>' }));
    put(root, '.claude/agents/a.md', '---\nname: a\n---\n');
    assert.throws(() => classifySnapshot(root), /displayName must be plain text/);
    put(root, 'rundock.json', JSON.stringify({ name: 'lean-team', version: '1.0.0', displayName: 'Lean Agent Team' }));
    assert.strictEqual(classifySnapshot(root).kind, 'content');
    assert.strictEqual(readPackageDisplayName(root), 'Lean Agent Team');
  });
});

describe('carried and shown', () => {
  test('the record and the roster carry it, and a card is titled with it', () => {
    const ws = makeTempDir('display-name-ws-');
    const snap = extension({ displayName: 'CSV Viewer' });
    const record = installExtension(ws, snap, planExtensionInstall(ws, snap, { url: 'https://github.com/someone/csv-table', reference: 'v1.0.0' }));
    assert.strictEqual(record.displayName, 'CSV Viewer');
    assert.strictEqual(listExtensions(ws)[0].displayName, 'CSV Viewer');
    assert.strictEqual(packageCards(ws)[0].title, 'CSV Viewer');
  });

  test('a record edited to carry markup is not shown as a name', () => {
    const ws = makeTempDir('display-name-ws-');
    const snap = extension();
    installExtension(ws, snap, planExtensionInstall(ws, snap, { url: 'https://github.com/someone/csv-table', reference: 'v1.0.0' }));
    const file = path.join(ws, '.rundock', 'extensions.json');
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    store.extensions[0].displayName = '<script>x</script>';
    fs.writeFileSync(file, JSON.stringify(store));
    assert.ok(!('displayName' in listExtensions(ws)[0]));
    assert.strictEqual(packageCards(ws)[0].title, 'Csv Table', 'the title-cased slug stands in');
  });

  test('the receipt carries it, and the card of a package of agents and skills is titled with it', () => {
    const ws = makeTempDir('display-name-ws-');
    const src = makeTempDir('display-name-src-');
    put(src, '.claude/agents/a.md', '---\nname: a\n---\n\nA.\n');
    const plan = buildPlan(ws, src, { id: 'https://github.com/someone/lean-team', reference: 'v1.0.0' });
    applyImport(ws, src, decide(plan, { 'agent:a': 'add' }), { receipt: { now: '2026-09-24T09:00:00.000Z', run: 'dn', displayName: 'Lean Agent Team' } });
    assert.strictEqual(listReceipts(ws)[0].displayName, 'Lean Agent Team');
    assert.strictEqual(packageCards(ws)[0].title, 'Lean Agent Team');
  });

  test('the install card names the package, falling back to the title-cased slug', () => {
    const state = { facts: { agents: 0, skills: 0, files: [], match: '*.csv' }, manifest: { name: 'csv-table', version: '1.0.0' }, link: 'someone/csv-table', reference: 'v1.0.0' };
    assert.strictEqual(install.trustCopy(state).headline, 'Install Csv Table 1.0.0?');
    assert.strictEqual(install.trustCopy({ ...state, manifest: { ...state.manifest, displayName: 'CSV Viewer' } }).headline, 'Install CSV Viewer 1.0.0?');
  });
});
