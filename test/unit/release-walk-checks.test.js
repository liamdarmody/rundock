'use strict';
// The release walk's checks, held to where the product actually keeps things.
//
// The walk failed four steps on two releases in a row while the product was
// fine: it looked for a pin in a home-directory file pins no longer use, and
// for a package card keyed by the extension's name when cards are keyed by
// the package's source link. Each check here runs the walk's own selector or
// reader against the product's own code: the server's derivation of the
// Packages page, the client's model and markup for a card, and the pins
// store. When the product moves, these go red here, without a browser or a
// network, before a release walk does.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { packageCard, storedPins } = require('../../scripts/walk/steps.js');
const { LEAN_TEAM, CSV_EXTENSION } = require('../../scripts/walk/repos.js');
const { packageCards } = require('../../lib/packages/package-state.js');
const { parseGitHubSource } = require('../../lib/packages/extension-source.js');
const { serialiseRecords, RECORDS_PATH } = require('../../lib/packages/extension-record.js');
const pins = require('../../lib/store/pins.js');
const updateModel = require('../../public/packages-update-model.js');
const settings = require('../../public/views/settings.js');

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walk-checks-'));
}

function write(ws, rel, text) {
  const file = path.join(ws, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// The link the walk types into the Packages page, as the server reads it.
const typedSource = (spec) => parseGitHubSource(`${spec.repo}@${spec.tag}`);

// The Packages page for a workspace, drawn by the client's own model and
// markup into a document the walk's selectors can be run against.
function packagesPage(ws) {
  const page = { packages: packageCards(ws), extensions: [] };
  const escape = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.esc = escape;
  global.escAttr = escape;
  try {
    const html = updateModel.cardRows(updateModel.initial(), page).map(settings.packagesCardHtml).join('');
    return new JSDOM(`<!doctype html><div id="packages-installed">${html}</div>`).window.document;
  } finally {
    delete global.esc;
    delete global.escAttr;
  }
}

test('an extension-only package has a card the walk finds, with its version and Uninstall action', () => {
  const ws = workspace();
  try {
    // What an extension install leaves: a record and no receipt.
    const source = typedSource(CSV_EXTENSION);
    write(ws, RECORDS_PATH, serialiseRecords([{
      name: CSV_EXTENSION.name, version: '1.0.1', entry: 'ui/index.js', match: CSV_EXTENSION.match,
      source: { url: source.url, reference: source.reference }, installedAt: '2026-10-08T12:00:00.000Z', root: `.rundock/extensions/${CSV_EXTENSION.name}`,
    }]));
    const doc = packagesPage(ws);
    const card = doc.querySelector(packageCard(CSV_EXTENSION));
    assert.ok(card, `no card matches ${packageCard(CSV_EXTENSION)}`);
    assert.match(card.querySelector('.pkg-card-ver').textContent, /1\.0\.1/);
    assert.ok(card.querySelector('[data-action="uninstall"]'), 'the Uninstall action is on the card');
    // The selector the walk used before: keyed by the extension's name, which
    // is not the card's key, so it matched nothing.
    assert.strictEqual(doc.querySelector(`.pkg-card-row[data-package$="/${CSV_EXTENSION.name}"]`), null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a package installed from its link has a card the walk finds by that link', () => {
  const ws = workspace();
  try {
    const source = typedSource(LEAN_TEAM);
    write(ws, '.claude/agents/chief-of-staff.md', '---\nname: chief-of-staff\n---\nHi.\n');
    write(ws, '.rundock/receipts/2026-10-08-team.json', JSON.stringify({
      schema: 'rundock.package-import-receipt/v1',
      source: { id: source.url, reference: source.reference },
      appliedAt: '2026-10-08T12:00:00.000Z',
      items: [{ id: 'agent:chief-of-staff', kind: 'agent', destination: '.claude/agents/chief-of-staff.md', decision: 'add', outcome: 'written', fingerprint: `sha256:${'0'.repeat(64)}` }],
    }));
    const card = packagesPage(ws).querySelector(packageCard(LEAN_TEAM));
    assert.ok(card, `no card matches ${packageCard(LEAN_TEAM)}`);
    assert.match(card.querySelector('.pkg-card-counts').textContent, /agent/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('the walk reads a pin where the pins store writes it, in the workspace', () => {
  const ws = workspace();
  try {
    assert.deepStrictEqual(storedPins(ws), [], 'no pins file reads as none');
    pins.pinFile(ws, 'walk-target.md');
    assert.deepStrictEqual(storedPins(ws), ['walk-target.md']);
    assert.strictEqual(pins.pinsFile(ws), path.join(ws, '.rundock', 'pins.json'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
