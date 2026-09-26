'use strict';
// Starter files: a package's `starter/` folder mirrors the workspace, and
// each file in it lands at the same relative path, only where nothing exists
// yet, never into a hidden path, never through a symlink, and belongs to the
// person afterwards. Driven through the real plan, decision contract,
// evaluator and apply, so what is asserted is what an install does.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
const { applyImport, evaluateApproval, digestFile } = require('../../lib/packages/import-apply.js');
const { evaluateImport, isStarterPath } = require('../../lib/packages/import-evaluate.js');
const { makeTempDir } = require('../helpers/workspace.js');

const SOURCE = { id: 'github.com/example/investing', reference: 'v1.0.0' };
const AGENT = '---\nname: analyst\n---\n\nAnalyse.\n';

function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

function pack(files = {}) {
  const source = makeTempDir('starter-src-');
  write(source, '.claude/agents/analyst.md', AGENT);
  for (const [rel, content] of Object.entries(files)) write(source, rel, content);
  return source;
}

// Every item decided the way the offer opens it: new items added, anything
// that collides skipped.
function openingDecisions(plan) {
  return Object.fromEntries(plan.items.map((i) => [i.id, i.collision ? 'skip' : 'add']));
}

function receiptOf(workspace, result) {
  return JSON.parse(fs.readFileSync(path.join(workspace, result.receipt), 'utf8'));
}

describe('discovery reads starter/ into one item per file', () => {
  test('each file becomes a starter item landing at the same relative path, unchanged', () => {
    const source = pack({ 'starter/Investments/Portfolio.md': '# Portfolio\n', 'starter/Investments/Watchlist.md': '# Watch\n' });
    const workspace = makeTempDir('starter-ws-');
    const plan = buildPlan(workspace, source, SOURCE);
    const starters = plan.items.filter((i) => i.kind === 'starter');
    assert.deepStrictEqual(starters.map((i) => [i.id, i.destination]), [
      ['starter:Investments/Portfolio.md', 'Investments/Portfolio.md'],
      ['starter:Investments/Watchlist.md', 'Investments/Watchlist.md'],
    ]);
    for (const item of starters) {
      assert.strictEqual(item.collision, false);
      assert.strictEqual(item.agent, null);
      assert.strictEqual(item.approvedDigest, item.sourceDigest, 'a starter file lands byte for byte as the author wrote it');
    }
  });

  test('a hidden segment anywhere in the path is refused by name, never dropped', () => {
    // The refusal names the first hidden segment it meets, file or folder.
    for (const [rel, named] of [['starter/Investments/.gitkeep', 'starter/Investments/.gitkeep'],
      ['starter/.config/x.md', 'starter/.config'], ['starter/.claude/agents/sneaky.md', 'starter/.claude']]) {
      const source = pack({ [rel]: 'x' });
      assert.throws(() => buildPlan(makeTempDir('starter-ws-'), source, SOURCE),
        (e) => e.code === 'package-refused' && /hidden path/.test(e.message) && e.message.includes(`${named} is`), rel);
    }
  });

  test('a symlink inside starter/ is refused, never followed', () => {
    const source = pack({ 'starter/Investments/Portfolio.md': 'p' });
    fs.symlinkSync('/etc/hosts', path.join(source, 'starter', 'Investments', 'hosts.md'));
    assert.throws(() => buildPlan(makeTempDir('starter-ws-'), source, SOURCE),
      (e) => e.code === 'package-refused' && /symlink/.test(e.message));
  });

  test('two starter files whose paths differ only by case are refused', (t) => {
    const source = pack({ 'starter/Notes.md': '1', 'starter/notes.md': '2' });
    // A case-insensitive filesystem (the macOS default) holds these as one
    // file, so the package cannot even be built there; the refusal is for
    // the repository checked out on a filesystem that can.
    if (fs.readdirSync(path.join(source, 'starter')).length < 2) return t.skip('this filesystem folds case');
    assert.throws(() => buildPlan(makeTempDir('starter-ws-'), source, SOURCE),
      (e) => e.code === 'package-refused' && /differ only by case/.test(e.message));
  });

  test('a repository holding only starter files is still nothing to add', () => {
    const source = makeTempDir('starter-src-');
    write(source, 'starter/Investments/Portfolio.md', 'p');
    assert.throws(() => buildPlan(makeTempDir('starter-ws-'), source, SOURCE), (e) => e.code === 'empty-package');
  });
});

describe('apply writes a starter file only where nothing exists', () => {
  test('an absent path is written with the author\'s bytes, and recorded with its fingerprint', () => {
    const source = pack({ 'starter/Investments/Portfolio.md': '# Portfolio\n' });
    const workspace = makeTempDir('starter-ws-');
    const plan = buildPlan(workspace, source, SOURCE);
    const result = applyImport(workspace, source, decide(plan, openingDecisions(plan)), { receipt: {} });
    assert.strictEqual(result.status, 'ready');
    const landed = path.join(workspace, 'Investments', 'Portfolio.md');
    assert.strictEqual(fs.readFileSync(landed, 'utf8'), '# Portfolio\n');
    const entry = receiptOf(workspace, result).items.find((i) => i.id === 'starter:Investments/Portfolio.md');
    assert.deepStrictEqual({ kind: entry.kind, destination: entry.destination, outcome: entry.outcome },
      { kind: 'starter', destination: 'Investments/Portfolio.md', outcome: 'written' });
    assert.strictEqual(entry.fingerprint, digestFile(fs.readFileSync(landed)));
  });

  test('a path the person already has is kept: planned as a collision, decided skip, never written', () => {
    const source = pack({ 'starter/Investments/Portfolio.md': 'the author\'s version' });
    const workspace = makeTempDir('starter-ws-');
    write(workspace, 'Investments/Portfolio.md', 'my real holdings');
    const plan = buildPlan(workspace, source, SOURCE);
    const item = plan.items.find((i) => i.kind === 'starter');
    assert.strictEqual(item.collision, true);
    const result = applyImport(workspace, source, decide(plan, openingDecisions(plan)), { receipt: {} });
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'Investments', 'Portfolio.md'), 'utf8'), 'my real holdings');
    const entry = receiptOf(workspace, result).items.find((i) => i.kind === 'starter');
    assert.strictEqual(entry.outcome, 'skipped');
    assert.ok(!('fingerprint' in entry));
  });

  test('no approval can overwrite a starter file: the evaluator refuses the decision', () => {
    const source = pack({ 'starter/Investments/Portfolio.md': 'author' });
    const workspace = makeTempDir('starter-ws-');
    write(workspace, 'Investments/Portfolio.md', 'mine');
    const plan = buildPlan(workspace, source, SOURCE);
    const decisions = openingDecisions(plan);
    decisions['starter:Investments/Portfolio.md'] = 'overwrite';
    assert.throws(() => evaluateApproval(workspace, source, decide(plan, decisions)), /never overwritten/);
    assert.throws(() => applyImport(workspace, source, decide(plan, decisions), { receipt: {} }), /never overwritten/);
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'Investments', 'Portfolio.md'), 'utf8'), 'mine');
  });

  test('a symlinked folder on the way counts as taken, so nothing is written through it', () => {
    const source = pack({ 'starter/Investments/Portfolio.md': 'author' });
    const workspace = makeTempDir('starter-ws-');
    const outside = makeTempDir('starter-outside-');
    fs.symlinkSync(outside, path.join(workspace, 'Investments'));
    const plan = buildPlan(workspace, source, SOURCE);
    assert.strictEqual(plan.items.find((i) => i.kind === 'starter').collision, true);
    applyImport(workspace, source, decide(plan, openingDecisions(plan)), { receipt: {} });
    assert.deepStrictEqual(fs.readdirSync(outside), [], 'nothing reached the folder the link points at');
  });

  test('a symlink at the path itself counts as taken, and what it points at is untouched', () => {
    const source = pack({ 'starter/Investments/Portfolio.md': 'author' });
    const workspace = makeTempDir('starter-ws-');
    const outside = path.join(makeTempDir('starter-outside-'), 'target.md');
    fs.writeFileSync(outside, 'elsewhere');
    fs.mkdirSync(path.join(workspace, 'Investments'));
    fs.symlinkSync(outside, path.join(workspace, 'Investments', 'Portfolio.md'));
    const plan = buildPlan(workspace, source, SOURCE);
    assert.strictEqual(plan.items.find((i) => i.kind === 'starter').collision, true);
    applyImport(workspace, source, decide(plan, openingDecisions(plan)), { receipt: {} });
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'elsewhere');
    assert.ok(fs.lstatSync(path.join(workspace, 'Investments', 'Portfolio.md')).isSymbolicLink(), 'the link itself is left as it was');
  });

  test('a file standing where a folder belongs counts as taken', () => {
    const source = pack({ 'starter/Investments/Portfolio.md': 'author' });
    const workspace = makeTempDir('starter-ws-');
    write(workspace, 'Investments', 'a file, not a folder');
    const plan = buildPlan(workspace, source, SOURCE);
    assert.strictEqual(plan.items.find((i) => i.kind === 'starter').collision, true);
    const result = applyImport(workspace, source, decide(plan, openingDecisions(plan)), { receipt: {} });
    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'Investments'), 'utf8'), 'a file, not a folder');
  });

  test('a file created at the path after the review voids it rather than being overwritten', () => {
    const source = pack({ 'starter/Investments/Portfolio.md': 'author' });
    const workspace = makeTempDir('starter-ws-');
    const plan = buildPlan(workspace, source, SOURCE);
    write(workspace, 'Investments/Portfolio.md', 'written meanwhile');
    const result = applyImport(workspace, source, decide(plan, openingDecisions(plan)), { receipt: {} });
    assert.strictEqual(result.status, 'stale');
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'Investments', 'Portfolio.md'), 'utf8'), 'written meanwhile');
  });
});

describe('the evaluator holds the starter path rule itself', () => {
  test('isStarterPath accepts ordinary workspace paths and refuses hidden, traversing and absolute ones', () => {
    for (const ok of ['Portfolio.md', 'Investments/Portfolio.md', 'Investments/2026 Q3 (draft).md']) {
      assert.strictEqual(isStarterPath(ok), true, ok);
    }
    for (const bad of ['', '.hidden.md', 'a/.b/c.md', '../x.md', 'a/../b.md', '/abs.md', 'a//b.md', 'a\\b.md', 'a/b.md/', 'trailing.', 'con:tent.md', 'a\nb.md']) {
      assert.strictEqual(isStarterPath(bad), false, JSON.stringify(bad));
    }
  });

  test('a hand-built approval naming a hidden destination is refused before anything is read', () => {
    const approval = {
      schema: 'rundock.package-import-approval/v1',
      source: { id: 'x', reference: null },
      manifest: [{ id: 'starter:.claude/agents/x.md', kind: 'starter', slug: '.claude/agents/x.md', sourceDigest: digestFile(Buffer.from('x')) }],
      items: [{
        id: 'starter:.claude/agents/x.md', kind: 'starter', slug: '.claude/agents/x.md', destination: '.claude/agents/x.md',
        collision: false, decision: 'add', plannedDigest: 'absent', approvedDigest: digestFile(Buffer.from('x')),
        sourceDigest: digestFile(Buffer.from('x')), agent: null,
      }],
    };
    assert.throws(() => evaluateImport(approval, { destinations: [], sources: [], agents: [] }), /starter file path/);
  });
});
