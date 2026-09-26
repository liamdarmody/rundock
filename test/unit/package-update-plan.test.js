'use strict';
// The update plan, end to end through the real pieces: install v1 through
// the real plan and apply, let the person work in the workspace, then plan
// v2 and hand its approval to the unchanged evaluator and transaction.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
const { applyImport, evaluateApproval } = require('../../lib/packages/import-apply.js');
const { installedPackages } = require('../../lib/packages/package-state.js');
const { buildUpdatePlan } = require('../../lib/packages/package-update-plan.js');
const { migrateAgentRoutines, updateRoutineBlock } = require('../../lib/agents/routines.js');
const { makeTempDir } = require('../helpers/workspace.js');

const URL = 'https://github.com/someone/pack';
const SCOUT = (body) => `---\nname: scout\nroutines:\n  - name: Morning briefing\n    schedule: every day at 08:00\n    prompt: Summarise.\n---\n\n${body}\n`;
const WRITER = (body) => `---\nname: writer\n---\n\n${body}\n`;

function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}
const read = (root, relative) => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');

function source(files) {
  const root = makeTempDir('upd-src-');
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return root;
}

function install(workspace, sourceRoot, reference, decisions = {}) {
  const plan = buildPlan(workspace, sourceRoot, { id: URL, reference });
  const approval = decide(plan, Object.fromEntries(plan.items.map((i) => [i.id, decisions[i.id] || (i.collision ? 'skip' : 'add')])));
  const result = applyImport(workspace, sourceRoot, approval, { receipt: { now: '2026-09-01T09:00:00.000Z', run: reference } });
  assert.strictEqual(result.status, 'ready');
}

const V1 = {
  '.claude/agents/scout.md': SCOUT('You scout.'),
  '.claude/agents/writer.md': WRITER('You write.'),
  '.claude/skills/notes/SKILL.md': 'Take notes.',
  '.claude/skills/old/SKILL.md': 'Old skill.',
  'starter/Investments/Portfolio.md': 'ticker,qty\n',
};

function scenario() {
  const workspace = makeTempDir('upd-ws-');
  install(workspace, source(V1), 'v1.0.0');
  // The person works: the routine is migrated on read and switched on, and
  // the writer's instructions are edited.
  const scoutFile = path.join(workspace, '.claude/agents/scout.md');
  const migrated = migrateAgentRoutines(scoutFile, read(workspace, '.claude/agents/scout.md'));
  fs.writeFileSync(scoutFile, updateRoutineBlock(migrated, 'Morning briefing', { enabled: true }));
  write(workspace, '.claude/agents/writer.md', read(workspace, '.claude/agents/writer.md').replace('You write.', 'You write in my style.'));
  const v2 = source({
    '.claude/agents/scout.md': SCOUT('You scout further.'),
    '.claude/agents/writer.md': WRITER('You write better.'),
    '.claude/skills/notes/SKILL.md': 'Take notes.',
    '.claude/skills/fresh/SKILL.md': 'Fresh skill.',
    'starter/Investments/Portfolio.md': 'ticker,qty\n',
  });
  const [pkg] = installedPackages(workspace);
  return { workspace, v2, pkg, plan: buildUpdatePlan(workspace, v2, pkg, { url: URL, reference: 'v2.0.0' }) };
}

const idsOf = (plan, group) => (plan.groups[group] || []).map((e) => e.id);

describe('buildUpdatePlan', () => {
  test('each item lands in its group', () => {
    const { plan } = scenario();
    assert.deepStrictEqual(idsOf(plan, 'author-changed'), ['agent:scout'], 'switching a routine on is not an edit');
    assert.deepStrictEqual(idsOf(plan, 'both-changed'), ['agent:writer']);
    assert.deepStrictEqual(idsOf(plan, 'matches'), ['skill:notes', 'starter:Investments/Portfolio.md']);
    assert.deepStrictEqual(idsOf(plan, 'new'), ['skill:fresh']);
    assert.deepStrictEqual(idsOf(plan, 'retired'), ['skill:old']);
    assert.strictEqual(plan.groups['both-changed'][0].saveAuthor, true);
  });

  test('the approval is ready by the unchanged evaluator, and applying it keeps the person\'s work', () => {
    const { workspace, v2, plan } = scenario();
    assert.strictEqual(evaluateApproval(workspace, v2, plan.approval).status, 'ready');
    const result = applyImport(workspace, v2, plan.approval, { receipt: { now: '2026-09-02T09:00:00.000Z', run: 'v2' } });
    assert.strictEqual(result.status, 'ready');
    const scout = read(workspace, '.claude/agents/scout.md');
    assert.match(scout, /You scout further\./, 'the author\'s change landed');
    assert.match(scout, /enabled: true/, 'the person\'s switch survived it');
    assert.match(read(workspace, '.claude/agents/writer.md'), /You write in my style\./, 'the person\'s edit was kept');
    assert.strictEqual(read(workspace, '.claude/skills/fresh/SKILL.md'), 'Fresh skill.');
    assert.strictEqual(read(workspace, '.claude/skills/old/SKILL.md'), 'Old skill.', 'a retired item is kept');
  });

  test('after the update, the next update sees the new version as the base', () => {
    const { workspace, v2, plan } = scenario();
    applyImport(workspace, v2, plan.approval, { receipt: { now: '2026-09-02T09:00:00.000Z', run: 'v2' } });
    const [pkg] = installedPackages(workspace);
    const again = buildUpdatePlan(workspace, v2, pkg, { url: URL, reference: 'v2.0.1' });
    assert.deepStrictEqual(idsOf(again, 'author-changed'), []);
    assert.ok(idsOf(again, 'matches').includes('agent:scout'));
    assert.deepStrictEqual(idsOf(again, 'both-changed'), ['agent:writer'], 'the kept edit still differs from the author');
  });

  test('a starter file the new version no longer carries is the person\'s, never marked', () => {
    const workspace = makeTempDir('upd-ws-');
    install(workspace, source(V1), 'v1.0.0');
    const v2 = { ...V1 };
    delete v2['starter/Investments/Portfolio.md'];
    const [pkg] = installedPackages(workspace);
    const plan = buildUpdatePlan(workspace, source(v2), pkg, { url: URL, reference: 'v2.0.0' });
    assert.deepStrictEqual(idsOf(plan, 'retired'), []);
  });

  test('an adopted leader is adopted again on its new version', () => {
    const workspace = makeTempDir('upd-ws-');
    write(workspace, '.claude/agents/boss.md', '---\nname: boss\norder: 0\n---\n\nLead.\n');
    const LEAD = (body) => `---\nname: chief\ntype: orchestrator\norder: 0\n---\n\n${body}\n`;
    const v1 = source({ '.claude/agents/chief.md': LEAD('Lead the pack.'), '.claude/agents/aide.md': '---\nname: aide\nreportsTo: chief\n---\n\nHelp.\n' });
    install(workspace, v1, 'v1.0.0', { 'agent:chief': 'adopt' });
    assert.match(read(workspace, '.claude/agents/chief.md'), /reportsTo: boss/);
    const v2 = source({ '.claude/agents/chief.md': LEAD('Lead the pack well.'), '.claude/agents/aide.md': '---\nname: aide\nreportsTo: chief\n---\n\nHelp.\n' });
    const [pkg] = installedPackages(workspace);
    const plan = buildUpdatePlan(workspace, v2, pkg, { url: URL, reference: 'v2.0.0' });
    assert.deepStrictEqual(idsOf(plan, 'author-changed'), ['agent:chief']);
    assert.strictEqual(applyImport(workspace, v2, plan.approval).status, 'ready');
    const chief = read(workspace, '.claude/agents/chief.md');
    assert.match(chief, /Lead the pack well\./);
    assert.match(chief, /reportsTo: boss/);
    assert.match(chief, /type: specialist/);
  });

  test('a new version that gains a key acting without asking is kept back, and its author version marked for review', () => {
    const workspace = makeTempDir('upd-ws-');
    install(workspace, source(V1), 'v1.0.0');
    const v2 = source({ ...V1, '.claude/skills/notes/SKILL.md': '---\nname: notes\nhooks:\n  Stop: echo hi\n---\nTake notes.' });
    const [pkg] = installedPackages(workspace);
    const plan = buildUpdatePlan(workspace, v2, pkg, { url: URL, reference: 'v2.0.0' });
    assert.deepStrictEqual(idsOf(plan, 'acts-without-asking'), ['skill:notes']);
    assert.strictEqual(plan.approval.items.find((i) => i.id === 'skill:notes').decision, 'skip');
  });
});

describe('a changed starter template arrives alongside, never over the person\'s file', () => {
  function starterScenario(personEdits) {
    const workspace = makeTempDir('upd-ws-');
    install(workspace, source(V1), 'v1.0.0');
    if (personEdits) write(workspace, 'Investments/Portfolio.md', 'ticker,qty\nAAPL,10\n');
    const v2 = source({ ...V1, 'starter/Investments/Portfolio.md': 'ticker,qty,currency\n' });
    const [pkg] = installedPackages(workspace);
    return { workspace, v2, plan: buildUpdatePlan(workspace, v2, pkg, { url: URL, reference: 'v1.3.0' }) };
  }

  for (const personEdits of [false, true]) {
    test(`the new template lands beside the old one, named for its version${personEdits ? ', and the person\'s data is untouched' : ''}`, () => {
      const { workspace, v2, plan } = starterScenario(personEdits);
      const [entry] = plan.groups['starter-alongside'];
      assert.strictEqual(entry.id, 'starter:Investments/Portfolio.md');
      assert.strictEqual(entry.alongside, 'Investments/Portfolio (v1.3.0).md');
      assert.ok(!idsOf(plan, 'new').includes('starter:Investments/Portfolio (v1.3.0).md'), 'the copy is shown with its original, not as a separate new item');
      const before = read(workspace, 'Investments/Portfolio.md');
      assert.strictEqual(applyImport(workspace, v2, plan.approval).status, 'ready');
      assert.strictEqual(read(workspace, 'Investments/Portfolio.md'), before);
      assert.strictEqual(read(workspace, 'Investments/Portfolio (v1.3.0).md'), 'ticker,qty,currency\n');
    });
  }

  test('where the alongside name is already taken, the person\'s file there is kept too', () => {
    const workspace = makeTempDir('upd-ws-');
    install(workspace, source(V1), 'v1.0.0');
    write(workspace, 'Investments/Portfolio (v1.3.0).md', 'mine');
    const v2 = source({ ...V1, 'starter/Investments/Portfolio.md': 'ticker,qty,currency\n' });
    const [pkg] = installedPackages(workspace);
    const plan = buildUpdatePlan(workspace, v2, pkg, { url: URL, reference: 'v1.3.0' });
    assert.strictEqual(plan.groups['starter-alongside'][0].alongsideKept, true);
    assert.strictEqual(applyImport(workspace, v2, plan.approval).status, 'ready');
    assert.strictEqual(read(workspace, 'Investments/Portfolio (v1.3.0).md'), 'mine');
  });

  test('a tag carrying characters a file name cannot hold is made safe', () => {
    const workspace = makeTempDir('upd-ws-');
    install(workspace, source(V1), 'v1.0.0');
    const v2 = source({ ...V1, 'starter/Investments/Portfolio.md': 'x' });
    const [pkg] = installedPackages(workspace);
    const plan = buildUpdatePlan(workspace, v2, pkg, { url: URL, reference: 'release/2:0' });
    assert.strictEqual(plan.groups['starter-alongside'][0].alongside, 'Investments/Portfolio (release-2-0).md');
  });
});
