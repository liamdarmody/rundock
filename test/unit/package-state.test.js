'use strict';
// Installed packages, derived: the receipts for one source folded into what
// that package installed and what its bytes were, joined to its extension
// record by URL. No store of its own, so nothing here can disagree with the
// receipts and records it reads.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { installedPackages } = require('../../lib/packages/package-state.js');
const { listReceipts, RECEIPTS_DIR } = require('../../lib/packages/extension-manage.js');
const { makeTempDir } = require('../helpers/workspace.js');

const URL = 'https://github.com/someone/pack';
const D = (c) => `sha256:${c.repeat(64)}`;
const COMMIT_1 = '1'.repeat(40);
const COMMIT_2 = '2'.repeat(40);

function receipt(root, file, body) {
  const absolute = path.join(root, ...RECEIPTS_DIR.split('/'), file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify({ schema: 'rundock.package-import-receipt/v1', ...body }));
}

function records(root, extensions) {
  fs.mkdirSync(path.join(root, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rundock', 'extensions.json'), JSON.stringify({ schema: 'rundock.extensions/v1', extensions }));
}

const agent = (outcome, extra = {}) => ({ id: 'agent:scout', kind: 'agent', destination: '.claude/agents/scout.md', decision: 'add', outcome, ...extra });

describe('the receipt reader keeps what an update needs', () => {
  test('fingerprint, authored, transform and the source commit survive the read; malformed ones do not', () => {
    const root = makeTempDir('pkg-state-');
    receipt(root, 'a.json', {
      source: { id: URL, reference: 'v1.0.0', commit: COMMIT_1 }, appliedAt: '2026-09-01T09:00:00.000Z',
      items: [
        agent('written', { fingerprint: D('a'), authored: D('b'), transform: { adoptUnder: 'boss' } }),
        { id: 'skill:x', kind: 'skill', destination: '.claude/skills/x', outcome: 'written', fingerprint: 'nonsense', transform: { adoptUnder: 'a\nb' } },
      ],
    });
    const [read] = listReceipts(root);
    assert.deepStrictEqual(read.source, { id: URL, reference: 'v1.0.0', commit: COMMIT_1 });
    assert.strictEqual(read.items[0].fingerprint, D('a'));
    assert.strictEqual(read.items[0].authored, D('b'));
    assert.deepStrictEqual(read.items[0].transform, { adoptUnder: 'boss' });
    assert.ok(!('fingerprint' in read.items[1]) && !('transform' in read.items[1]));
  });
});

describe('the receipt reader keeps an item no longer in the package as kept', () => {
  test('a kept entry reads as not in the package; every other outcome carries no such mark', () => {
    const root = makeTempDir('pkg-state-');
    receipt(root, 'a.json', {
      source: { id: URL, reference: 'v1.1.0' }, appliedAt: '2026-09-02T09:00:00.000Z',
      items: [
        { id: 'agent:writer', kind: 'agent', destination: '.claude/agents/writer.md', outcome: 'kept', inPackage: false },
        agent('skipped', { decision: 'skip', inPackage: false }),
        { id: 'skill:x', kind: 'skill', destination: '.claude/skills/x', outcome: 'written', inPackage: 'no' },
      ],
    });
    const byId = Object.fromEntries(listReceipts(root)[0].items.map((i) => [i.id, i]));
    assert.strictEqual(byId['agent:writer'].inPackage, false);
    assert.ok(!('inPackage' in byId['agent:scout']), 'only a kept entry can say the package no longer carries it');
    assert.ok(!('inPackage' in byId['skill:x']));
  });
});

describe('the receipt reader refuses a commit that is not one', () => {
  test('a short or foreign commit is dropped, and the source keeps its old shape', () => {
    const root = makeTempDir('pkg-state-');
    receipt(root, 'a.json', { source: { id: URL, reference: 'v1.0.0', commit: 'abc123' }, appliedAt: '2026-09-01T09:00:00.000Z', items: [] });
    assert.deepStrictEqual(listReceipts(root)[0].source, { id: URL, reference: 'v1.0.0' });
  });
});

describe('installed packages', () => {
  test('the newest receipt names the version; each item keeps the newest base it was written with', () => {
    const root = makeTempDir('pkg-state-');
    receipt(root, 'a.json', {
      source: { id: URL, reference: 'v1.0.0', commit: COMMIT_1 }, appliedAt: '2026-09-01T09:00:00.000Z',
      items: [agent('written', { fingerprint: D('a'), authored: D('b') })],
    });
    receipt(root, 'b.json', {
      source: { id: URL, reference: 'v1.1.0', commit: COMMIT_2 }, appliedAt: '2026-09-02T09:00:00.000Z',
      items: [agent('skipped', { decision: 'skip' })],
    });
    const [pkg] = installedPackages(root);
    assert.strictEqual(pkg.id, URL);
    assert.strictEqual(pkg.reference, 'v1.1.0');
    assert.strictEqual(pkg.commit, COMMIT_2);
    assert.strictEqual(pkg.updatable, true);
    assert.deepStrictEqual(pkg.items['agent:scout'].base, { fingerprint: D('a'), authored: D('b') },
      'a later skip wrote nothing, so the earlier base still stands');
    assert.strictEqual(pkg.items['agent:scout'].lastOutcome, 'skipped');
  });

  test('an item never written by this package has no base', () => {
    const root = makeTempDir('pkg-state-');
    receipt(root, 'a.json', { source: { id: URL, reference: 'v1.0.0' }, appliedAt: '2026-09-01T09:00:00.000Z', items: [agent('skipped', { decision: 'skip' })] });
    assert.strictEqual(installedPackages(root)[0].items['agent:scout'].base, null);
  });

  test('a receipt of another source never contributes, and a deleted receipt takes only its own line with it', () => {
    const root = makeTempDir('pkg-state-');
    receipt(root, 'a.json', { source: { id: URL, reference: 'v1.0.0' }, appliedAt: '2026-09-01T09:00:00.000Z', items: [agent('written', { fingerprint: D('a') })] });
    receipt(root, 'b.json', { source: { id: 'https://github.com/other/pack', reference: 'v9.0.0' }, appliedAt: '2026-09-03T09:00:00.000Z', items: [agent('written', { fingerprint: D('c') })] });
    const mine = () => installedPackages(root).find((p) => p.id === URL);
    assert.deepStrictEqual(mine().items['agent:scout'].base, { fingerprint: D('a'), authored: null });
    fs.unlinkSync(path.join(root, ...RECEIPTS_DIR.split('/'), 'a.json'));
    assert.strictEqual(mine(), undefined);
    assert.strictEqual(installedPackages(root).length, 1);
  });

  test('a package added from a local folder is listed but cannot be updated', () => {
    const root = makeTempDir('pkg-state-');
    receipt(root, 'a.json', { source: { id: '/Users/me/pack', reference: null }, appliedAt: '2026-09-01T09:00:00.000Z', items: [agent('written', { fingerprint: D('a') })] });
    assert.strictEqual(installedPackages(root)[0].updatable, false);
  });

  test('an extension is joined by its source; an extension with no receipt is a package of its own', () => {
    const root = makeTempDir('pkg-state-');
    receipt(root, 'a.json', { source: { id: URL, reference: 'v1.0.0', commit: COMMIT_1 }, appliedAt: '2026-09-01T09:00:00.000Z', items: [agent('written', { fingerprint: D('a') })] });
    const ext = (name, url, reference, commit) => ({ name, version: '1.0.0', entry: 'index.js', match: '*.csv', root: `.rundock/extensions/${name}`, source: { url, reference, commit } });
    records(root, [
      ext('pack-view', URL, 'v1.0.0', COMMIT_1),
      ext('solo', 'https://github.com/someone/solo', 'v2.0.0', COMMIT_2),
    ]);
    const byId = new Map(installedPackages(root).map((p) => [p.id, p]));
    assert.strictEqual(byId.get(URL).extension, 'pack-view');
    const solo = byId.get('https://github.com/someone/solo');
    assert.strictEqual(solo.extension, 'solo');
    assert.strictEqual(solo.reference, 'v2.0.0');
    assert.strictEqual(solo.commit, COMMIT_2);
    assert.deepStrictEqual(solo.items, {});
  });

  test('a workspace with nothing installed has no packages', () => {
    assert.deepStrictEqual(installedPackages(makeTempDir('pkg-state-')), []);
  });
});

describe('package cards: what the Packages page shows for each installed package', () => {
  const { packageCards } = require('../../lib/packages/package-state.js');
  const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
  const { applyImport } = require('../../lib/packages/import-apply.js');
  const { migrateAgentRoutines, updateRoutineBlock } = require('../../lib/agents/routines.js');
  const put = (root, rel, content) => { const a = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, content); };
  const SCOUT = '---\nname: scout\nroutines:\n  - name: Morning briefing\n    schedule: every day at 08:00\n    prompt: Summarise.\n---\n\nScout.\n';

  function installed() {
    const root = makeTempDir('pkg-cards-');
    const src = makeTempDir('pkg-cards-src-');
    put(src, '.claude/agents/scout.md', SCOUT);
    put(src, '.claude/agents/writer.md', '---\nname: writer\n---\n\nWrite.\n');
    put(src, '.claude/skills/notes/SKILL.md', 'Notes.');
    put(src, 'starter/Investments/Portfolio.md', 'ticker\n');
    const plan = buildPlan(root, src, { id: URL, reference: 'v1.2.0' });
    applyImport(root, src, decide(plan, Object.fromEntries(plan.items.map((i) => [i.id, 'add']))), { receipt: { now: '2026-09-01T09:00:00.000Z', run: 'c', commit: COMMIT_1 } });
    return root;
  }

  test('counts per kind, links to each item, the release, and the extension with whether it is on', () => {
    const root = installed();
    records(root, [{ name: 'pack-view', version: '1.2.0', entry: 'index.js', match: '*.csv', root: '.rundock/extensions/pack-view', enabled: false, source: { url: URL, reference: 'v1.2.0' } }]);
    const [card] = packageCards(root);
    assert.deepStrictEqual([card.name, card.repo, card.reference, card.commit], ['pack', 'someone/pack', 'v1.2.0', COMMIT_1]);
    assert.deepStrictEqual(card.counts, { agent: 2, skill: 1, routine: 1, starter: 1, extension: 1 });
    assert.deepStrictEqual(card.extension, { name: 'pack-view', version: '1.2.0', enabled: false });
    const scout = card.items.find((i) => i.id === 'agent:scout');
    assert.deepStrictEqual([scout.open, scout.target, scout.routines], ['agent', 'scout', ['Morning briefing']]);
    assert.deepStrictEqual(card.items.find((i) => i.kind === 'starter').open, 'file');
  });

  test('each item says whether it is as installed, changed since, or gone; a routine switched on is not a change', () => {
    const root = installed();
    const scoutFile = path.join(root, '.claude', 'agents', 'scout.md');
    fs.writeFileSync(scoutFile, updateRoutineBlock(migrateAgentRoutines(scoutFile, fs.readFileSync(scoutFile, 'utf8')), 'Morning briefing', { enabled: true }));
    put(root, '.claude/skills/notes/SKILL.md', 'My notes.');
    fs.rmSync(path.join(root, '.claude', 'agents', 'writer.md'));
    const states = Object.fromEntries(packageCards(root)[0].items.map((i) => [i.id, i.state]));
    assert.deepStrictEqual(states, {
      'agent:scout': 'as-installed', 'agent:writer': 'absent', 'skill:notes': 'changed', 'starter:Investments/Portfolio.md': 'as-installed',
    });
    assert.strictEqual(packageCards(root)[0].counts.agent, 1, 'a removed item is not counted');
  });

  test('an item the newest version no longer carries is marked as not carried; everything the newest receipt lists is carried', () => {
    const root = makeTempDir('pkg-cards-carried-');
    const writer = { id: 'agent:writer', kind: 'agent', destination: '.claude/agents/writer.md', decision: 'add', outcome: 'written', fingerprint: D('c'), authored: D('d') };
    receipt(root, 'a.json', {
      source: { id: URL, reference: 'v1.0.0', commit: COMMIT_1 }, appliedAt: '2026-09-01T09:00:00.000Z',
      items: [agent('written', { fingerprint: D('a'), authored: D('b') }), writer],
    });
    // v1.1.0 no longer carries the writer; the scout is listed even though
    // this update wrote nothing to it, because the package still carries it.
    receipt(root, 'b.json', {
      source: { id: URL, reference: 'v1.1.0', commit: COMMIT_2 }, appliedAt: '2026-09-02T09:00:00.000Z',
      items: [agent('skipped', { decision: 'skip' })],
    });
    put(root, '.claude/agents/writer.md', 'kept\n');
    const carried = Object.fromEntries(packageCards(root)[0].items.map((i) => [i.id, i.carried]));
    assert.deepStrictEqual(carried, { 'agent:scout': true, 'agent:writer': false });
  });

  // An update's receipt lists each item the new version no longer
  // carries, as kept. Listed is not carried: only the entries the new version
  // itself offered (written, unchanged, skipped or blocked) are its contents.
  test('an item the newest receipt lists as kept, no longer in the package, is not carried and keeps its base', () => {
    const root = makeTempDir('pkg-cards-retired-');
    const writer = (extra) => ({ id: 'agent:writer', kind: 'agent', destination: '.claude/agents/writer.md', ...extra });
    receipt(root, 'a.json', {
      source: { id: URL, reference: 'v1.0.0', commit: COMMIT_1 }, appliedAt: '2026-09-01T09:00:00.000Z',
      items: [agent('written', { fingerprint: D('a'), authored: D('b') }), writer({ decision: 'add', outcome: 'written', fingerprint: D('c'), authored: D('d') })],
    });
    receipt(root, 'b.json', {
      source: { id: URL, reference: 'v1.1.0', commit: COMMIT_2 }, appliedAt: '2026-09-02T09:00:00.000Z',
      items: [agent('skipped', { decision: 'skip' }), writer({ outcome: 'kept', inPackage: false })],
    });
    put(root, '.claude/agents/writer.md', 'kept\n');
    const [pkg] = installedPackages(root);
    assert.strictEqual(pkg.items['agent:writer'].carried, false, 'listed as kept is not carried');
    assert.deepStrictEqual(pkg.items['agent:writer'].base, { fingerprint: D('c'), authored: D('d') },
      'a kept entry wrote nothing, so the last bytes the package wrote remain the base');
    assert.strictEqual(pkg.items['agent:scout'].carried, true, 'a skipped entry is one the new version offered, so it is carried');
    const cards = Object.fromEntries(packageCards(root)[0].items.map((i) => [i.id, i.carried]));
    assert.deepStrictEqual(cards, { 'agent:scout': true, 'agent:writer': false });
  });

  test('an item still listed as kept by a later update stays not carried, and one the package carries again is carried', () => {
    const root = makeTempDir('pkg-cards-retired-');
    const writer = (extra) => ({ id: 'agent:writer', kind: 'agent', destination: '.claude/agents/writer.md', ...extra });
    receipt(root, 'a.json', {
      source: { id: URL, reference: 'v1.0.0' }, appliedAt: '2026-09-01T09:00:00.000Z',
      items: [writer({ decision: 'add', outcome: 'written', fingerprint: D('c'), authored: D('d') })],
    });
    receipt(root, 'b.json', { source: { id: URL, reference: 'v1.1.0' }, appliedAt: '2026-09-02T09:00:00.000Z', items: [writer({ outcome: 'kept', inPackage: false })] });
    receipt(root, 'c.json', { source: { id: URL, reference: 'v1.2.0' }, appliedAt: '2026-09-03T09:00:00.000Z', items: [writer({ outcome: 'kept', inPackage: false })] });
    put(root, '.claude/agents/writer.md', 'kept\n');
    assert.strictEqual(packageCards(root)[0].items[0].carried, false);
    receipt(root, 'd.json', {
      source: { id: URL, reference: 'v1.3.0' }, appliedAt: '2026-09-04T09:00:00.000Z',
      items: [writer({ decision: 'skip', outcome: 'skipped' })],
    });
    assert.strictEqual(packageCards(root)[0].items[0].carried, true, 'the new version offers it again');
  });
});
