'use strict';
// Uninstalling a package: what the package put there and nobody changed
// goes; whatever the person made theirs stays; the package leaves the list;
// all of it in one transaction, and nothing the confirmation did not list.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
const { applyImport } = require('../../lib/packages/import-apply.js');
const { planExtensionInstall, installExtension } = require('../../lib/packages/extension-install.js');
const { readExtensionRecords, RECORDS_PATH, EXTENSIONS_ROOT } = require('../../lib/packages/extension-record.js');
const { packageCards } = require('../../lib/packages/package-state.js');
const { planUninstall, applyUninstall } = require('../../lib/packages/package-uninstall.js');
const { migrateAgentRoutines, updateRoutineBlock } = require('../../lib/agents/routines.js');
const { makeTempDir } = require('../helpers/workspace.js');

const URL = 'https://github.com/someone/investment-partner';
const OTHER = 'https://github.com/someone/other';
const SCOUT = '---\nname: scout\nroutines:\n  - name: Morning briefing\n    schedule: every day at 08:00\n    prompt: Summarise.\n---\n\nScout.\n';

function put(root, rel, content) {
  const absolute = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));

function tree(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), child); else out[child] = fs.readFileSync(path.join(dir, e.name), 'utf8');
    }
  };
  walk(root, '');
  return out;
}

function install(root, id, files, reference = 'v1.0.0') {
  const src = makeTempDir('uninstall-src-');
  for (const [rel, content] of Object.entries(files)) put(src, rel, content);
  const plan = buildPlan(root, src, { id, reference });
  applyImport(root, src, decide(plan, Object.fromEntries(plan.items.map((i) => [i.id, i.collision ? 'skip' : 'add']))),
    { receipt: { now: '2026-09-01T09:00:00.000Z', run: Buffer.from(id).toString('hex').slice(-6) } });
  if (files['rundock.json']) {
    installExtension(root, src, planExtensionInstall(root, src, { url: id, reference }));
  }
}

function workspace() {
  const root = makeTempDir('uninstall-ws-');
  install(root, URL, {
    '.claude/agents/scout.md': SCOUT,
    '.claude/agents/risk.md': '---\nname: risk\n---\n\nRisk.\n',
    '.claude/skills/review/SKILL.md': 'Review.',
    'starter/Investments/Portfolio.md': 'ticker\n',
    'rundock.json': JSON.stringify({ name: 'investment-partner', version: '1.0.0', extension: { entry: 'view/index.html', match: '*.ipx' } }),
    'view/index.html': '<main></main>',
  });
  install(root, OTHER, { '.claude/agents/helper.md': '---\nname: helper\n---\n\nHelp.\n' });
  // The person works: a routine switched on (not an edit), an agent edited.
  const scout = path.join(root, '.claude', 'agents', 'scout.md');
  fs.writeFileSync(scout, updateRoutineBlock(migrateAgentRoutines(scout, fs.readFileSync(scout, 'utf8')), 'Morning briefing', { enabled: true }));
  put(root, '.claude/agents/risk.md', '---\nname: risk\n---\n\nRisk, my way.\n');
  return root;
}

describe('the uninstall plan', () => {
  test('lists what goes (unchanged since install) and what stays (edited, and every starter file)', () => {
    const root = workspace();
    const plan = planUninstall(root, URL);
    assert.strictEqual(plan.title, 'Investment Partner');
    assert.deepStrictEqual(plan.goes.map((g) => g.id), ['agent:scout', 'skill:review'], 'a routine switched on is not an edit');
    assert.deepStrictEqual(plan.stays.map((s) => [s.id, s.why]), [['agent:risk', 'edited'], ['starter:Investments/Portfolio.md', 'starter']]);
    assert.deepStrictEqual(plan.extension, { name: 'investment-partner', root: '.rundock/extensions/investment-partner' });
  });

  test('a starter file stays even when nobody touched it', () => {
    const plan = planUninstall(workspace(), URL);
    assert.ok(!plan.goes.some((g) => g.kind === 'starter'));
  });

  test('an unknown package is refused, in a sentence', () => {
    assert.throws(() => planUninstall(workspace(), 'https://github.com/nobody/here'), /^Error: That package is not installed\.$/);
  });
});

describe('applying it', () => {
  test('removes what goes, keeps what stays, leaves every other package alone, and the package leaves the list', () => {
    const root = workspace();
    const plan = planUninstall(root, URL);
    applyUninstall(root, URL, plan.key);
    assert.ok(!exists(root, '.claude/agents/scout.md') && !exists(root, '.claude/skills/review'));
    assert.match(read(root, '.claude/agents/risk.md'), /my way/);
    assert.strictEqual(read(root, 'Investments/Portfolio.md'), 'ticker\n');
    assert.ok(!exists(root, '.rundock/extensions/investment-partner'));
    assert.deepStrictEqual(readExtensionRecords(root), []);
    assert.ok(exists(root, '.claude/agents/helper.md'), 'another package is untouched');
    assert.deepStrictEqual(packageCards(root).map((c) => c.id), [OTHER]);
  });

  test('a change after the confirmation was opened refuses the whole uninstall, and nothing moves', () => {
    const root = workspace();
    const plan = planUninstall(root, URL);
    put(root, '.claude/skills/review/SKILL.md', 'Review, edited just now.');
    const before = tree(root);
    assert.throws(() => applyUninstall(root, URL, plan.key), (e) => e.code === 'stale' && /nothing was removed/.test(e.message));
    assert.deepStrictEqual(tree(root), before);
  });

  test('a fault at any step leaves the workspace exactly as it was', () => {
    const probe = workspace();
    let steps = 0;
    applyUninstall(probe, URL, planUninstall(probe, URL).key, { afterStep: () => { steps += 1; } });
    assert.ok(steps > 6);
    for (let boundary = 1; boundary <= steps; boundary++) {
      const root = workspace();
      const key = planUninstall(root, URL).key;
      const before = tree(root);
      let completed = 0;
      assert.throws(() => applyUninstall(root, URL, key, {
        afterStep: () => { completed += 1; if (completed === boundary) throw new Error('injected fault'); },
      }), /injected fault/);
      assert.deepStrictEqual(tree(root), before, `after step ${boundary} of ${steps}`);
    }
  });
});

describe('view state leaves with its extension', () => {
  const { writeState, readState } = require('../../lib/packages/extension-state.js');
  const RISK = 'https://github.com/someone/risk-board';
  // Two packages with a view each, and state kept by both, one of them for
  // the same note as the other.
  function withState() {
    const root = workspace();
    install(root, RISK, {
      '.claude/agents/board.md': '---\nname: board\n---\n\nBoard.\n',
      'rundock.json': JSON.stringify({ name: 'risk-board', version: '1.0.0', extension: { entry: 'view/index.html', match: '*.risk' } }),
      'view/index.html': '<main></main>',
    });
    writeState(root, 'investment-partner', 'Investments/Portfolio.md', { 'rui.table.positions': { ticker: 120 } });
    writeState(root, 'investment-partner', 'Notes/Watchlist.md', { k: 1 });
    writeState(root, 'risk-board', 'Investments/Portfolio.md', { k: 2 });
    return root;
  }
  const rundockTree = (root) => tree(path.join(root, '.rundock'));

  test('uninstalling one package removes its extension\'s state folder, and every other byte under .rundock stays', () => {
    const root = withState();
    const before = rundockTree(root);
    const plan = planUninstall(root, URL);
    applyUninstall(root, URL, plan.key);
    assert.strictEqual(exists(root, '.rundock/extension-state/investment-partner'), false);
    assert.deepStrictEqual(readState(root, 'risk-board', 'Investments/Portfolio.md'), { k: 2 });
    const gone = ['extension-state/investment-partner/', 'extensions/investment-partner/', ...plan.receipts.map((r) => r.replace(/^\.rundock\//, ''))];
    const kept = Object.fromEntries(Object.entries(before)
      .filter(([file]) => file !== 'extensions.json' && !gone.some((g) => file === g || file.startsWith(g))));
    const after = rundockTree(root);
    delete after['extensions.json'];
    assert.deepStrictEqual(after, kept, 'only the package\'s own extension, receipts and state went');
    assert.deepStrictEqual(readExtensionRecords(root).map((r) => r.name), ['risk-board']);
  });

  test('a stale key removes nothing, and the state folder stays', () => {
    const root = withState();
    const plan = planUninstall(root, URL);
    put(root, '.claude/skills/review/SKILL.md', 'Review, edited just now.');
    const before = rundockTree(root);
    assert.throws(() => applyUninstall(root, URL, plan.key), (e) => e.code === 'stale');
    assert.deepStrictEqual(rundockTree(root), before);
    assert.deepStrictEqual(readState(root, 'investment-partner', 'Notes/Watchlist.md'), { k: 1 });
  });
});

describe('at the wire', () => {
  const handlers = require('../../lib/protocol/handlers/packages.js');
  const config = require('../../lib/config.js');
  const captureWs = () => ({ readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } });
  const ctx = () => {
    const c = { told: [], agents: { invalidateAgentCache() { c.told.push('cache'); }, flagRosterRefresh() { c.told.push('roster'); } }, workspace: { noteExtensionRecordsChanged() { c.told.push('tree'); } }, clients: [] };
    return c;
  };
  function withWs(root, deps, fn) {
    const previous = config.getWorkspace();
    config.setWorkspace(root);
    const prevDeps = handlers.wireExtensionDeps({ runningRuns: () => [], ...deps });
    try { return fn(); } finally { handlers.wireExtensionDeps(prevDeps); config.setWorkspace(previous); }
  }

  test('the plan, then the confirm naming it: the result lists what went and what stayed, and everything that reads the team is told', () => {
    const root = workspace();
    withWs(root, {}, () => {
      const sock = captureWs();
      handlers.handlePlanPackageUninstall({}, sock, { type: 'plan_package_uninstall', source: URL });
      const plan = sock.sent[0];
      assert.strictEqual(plan.type, 'package_uninstall_plan');
      const c = ctx();
      handlers.handleConfirmPackageUninstall(c, sock, { type: 'confirm_package_uninstall', source: URL, key: plan.key, requestId: 'u' });
      const result = sock.sent[1];
      assert.strictEqual(result.type, 'package_uninstall_result');
      assert.deepStrictEqual(result.removed.map((r) => r.id), ['agent:scout', 'skill:review']);
      assert.deepStrictEqual(result.kept.map((r) => r.id), ['agent:risk', 'starter:Investments/Portfolio.md']);
      assert.deepStrictEqual(result.extensions, []);
      assert.deepStrictEqual(c.told.sort(), ['cache', 'roster', 'tree']);
    });
  });

  test('a confirm without the plan\'s key removes nothing', () => {
    const root = workspace();
    withWs(root, {}, () => {
      const before = tree(root);
      const sock = captureWs();
      handlers.handleConfirmPackageUninstall(ctx(), sock, { type: 'confirm_package_uninstall', source: URL, key: 'not-the-plan' });
      assert.strictEqual(sock.sent[0].code, 'stale');
      assert.deepStrictEqual(tree(root), before);
    });
  });

  test('refused, in a sentence, while a routine of an agent it removes is running', () => {
    const root = workspace();
    withWs(root, { runningRuns: () => [{ agent: 'scout', routine: 'Morning briefing' }] }, () => {
      const sock = captureWs();
      handlers.handlePlanPackageUninstall({}, sock, { type: 'plan_package_uninstall', source: URL });
      const before = tree(root);
      handlers.handleConfirmPackageUninstall(ctx(), sock, { type: 'confirm_package_uninstall', source: URL, key: sock.sent[0].key });
      assert.strictEqual(sock.sent[1].code, 'routine-running');
      assert.strictEqual(sock.sent[1].message, "Wait for scout's Morning briefing run to finish, then uninstall.");
      assert.deepStrictEqual(tree(root), before);
    });
  });
});

describe('what uninstall never touches', () => {
  test('a file the person added inside a package\'s skill folder keeps the whole folder', () => {
    const root = workspace();
    put(root, '.claude/skills/review/my-notes.md', 'Mine.');
    const plan = planUninstall(root, URL);
    assert.ok(!plan.goes.some((g) => g.id === 'skill:review'), 'the folder is no longer as installed');
    assert.deepStrictEqual(plan.stays.find((s) => s.id === 'skill:review'), { id: 'skill:review', kind: 'skill', label: 'review', destination: '.claude/skills/review', why: 'edited' });
    applyUninstall(root, URL, plan.key);
    assert.strictEqual(read(root, '.claude/skills/review/my-notes.md'), 'Mine.');
    assert.strictEqual(read(root, '.claude/skills/review/SKILL.md'), 'Review.');
  });

  test('a symlink the person put inside a package\'s folder is never followed: the folder is kept, and what it points at is untouched', () => {
    const root = workspace();
    const outside = makeTempDir('uninstall-outside-');
    put(outside, 'precious.md', 'Not the package\'s.');
    fs.symlinkSync(outside, path.join(root, '.claude', 'skills', 'review', 'linked'));
    const plan = planUninstall(root, URL);
    assert.strictEqual(plan.stays.find((s) => s.id === 'skill:review').why, 'edited');
    applyUninstall(root, URL, plan.key);
    assert.ok(fs.lstatSync(path.join(root, '.claude', 'skills', 'review', 'linked')).isSymbolicLink());
    assert.strictEqual(fs.readFileSync(path.join(outside, 'precious.md'), 'utf8'), 'Not the package\'s.');
  });

  test('an agent file replaced by a symlink out of the workspace is kept, and its target untouched', () => {
    const root = workspace();
    const outside = makeTempDir('uninstall-outside-');
    put(outside, 'scout.md', SCOUT);
    fs.rmSync(path.join(root, '.claude', 'agents', 'scout.md'));
    fs.symlinkSync(path.join(outside, 'scout.md'), path.join(root, '.claude', 'agents', 'scout.md'));
    const plan = planUninstall(root, URL);
    assert.ok(!plan.goes.some((g) => g.id === 'agent:scout'), 'a link is never as installed');
    applyUninstall(root, URL, plan.key);
    assert.ok(fs.lstatSync(path.join(root, '.claude', 'agents', 'scout.md')).isSymbolicLink());
    assert.strictEqual(fs.readFileSync(path.join(outside, 'scout.md'), 'utf8'), SCOUT);
  });

  test('a package folder reached through a symlinked parent is refused whole, and nothing on either side moves', () => {
    const root = workspace();
    const outside = makeTempDir('uninstall-outside-');
    fs.cpSync(path.join(root, '.claude', 'skills'), path.join(outside, 'skills'), { recursive: true });
    fs.rmSync(path.join(root, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'skills'), path.join(root, '.claude', 'skills'));
    const plan = planUninstall(root, URL);
    assert.throws(() => applyUninstall(root, URL, plan.key), /symlink/);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'skills', 'review', 'SKILL.md'), 'utf8'), 'Review.');
    assert.ok(exists(root, '.claude/agents/scout.md'), 'the rest of the uninstall did not happen either');
  });

  test('an extension folder replaced by a symlink is refused, and what it points at is untouched', () => {
    const root = workspace();
    const outside = makeTempDir('uninstall-outside-');
    fs.cpSync(path.join(root, '.rundock', 'extensions', 'investment-partner'), path.join(outside, 'ext'), { recursive: true });
    fs.rmSync(path.join(root, '.rundock', 'extensions', 'investment-partner'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'ext'), path.join(root, '.rundock', 'extensions', 'investment-partner'));
    const plan = planUninstall(root, URL);
    assert.throws(() => applyUninstall(root, URL, plan.key), /symlink/);
    assert.ok(fs.existsSync(path.join(outside, 'ext', 'view', 'index.html')));
    assert.ok(exists(root, '.claude/agents/scout.md'), 'nothing else was removed');
  });

  // The records file can arrive with a shared or copied workspace carrying
  // anything, so its persisted root is never a removal target: the folder
  // removed is always the extensions root plus the record's own name.
  test('a record whose root was tampered to point outside is ignored: only the package\'s own extension folder goes', () => {
    const root = workspace();
    const outside = makeTempDir('uninstall-outside-');
    put(outside, 'must-survive.txt', 'Not the package\'s.');
    const file = path.join(root, ...RECORDS_PATH.split('/'));
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.extensions[0].root = path.relative(root, outside).split(path.sep).join('/');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const plan = planUninstall(root, URL);
    assert.strictEqual(plan.extension.root, '.rundock/extensions/investment-partner');
    applyUninstall(root, URL, plan.key);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'must-survive.txt'), 'utf8'), 'Not the package\'s.');
    assert.strictEqual(exists(root, '.rundock/extensions/investment-partner'), false);
  });

  test('a record whose name would climb out of the extensions folder is refused before any path is built, and nothing moves', () => {
    const root = workspace();
    const file = path.join(root, ...RECORDS_PATH.split('/'));
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.extensions[0].name = '../../etc';
    doc.extensions[0].root = `${EXTENSIONS_ROOT}/../../etc`;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const before = tree(root);
    // Refused by the records reader, which is the first to see the name; the
    // view-state folder's own check further on is a second line, not this one.
    assert.throws(() => applyUninstall(root, URL, planUninstall(root, URL).key), /an entry carries an invalid name/);
    assert.deepStrictEqual(tree(root), before);
  });
});
