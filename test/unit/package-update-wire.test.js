'use strict';
// A package update at the wire: planned from the installed package and a
// release the check reports newer, never from the message's own facts, and
// held under a token for the review.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const handlers = require('../../lib/protocol/handlers/packages.js');
const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
const { applyImport } = require('../../lib/packages/import-apply.js');
const config = require('../../lib/config.js');
const { makeTempDir } = require('../helpers/workspace.js');

const URL = 'https://github.com/someone/pack';
const C = (n) => String(n).repeat(40);

function captureWs() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
}
function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}
function tree(files) {
  const root = makeTempDir('upd-wire-src-');
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return root;
}
const MANIFEST = (name, version) => JSON.stringify({ name, version, extension: { entry: 'view/index.html', match: '*.dataview.md' } });
const V1 = { '.claude/agents/scout.md': '---\nname: scout\n---\n\nScout.\n', '.claude/skills/notes/SKILL.md': 'Notes.' };
const V2 = { '.claude/agents/scout.md': '---\nname: scout\n---\n\nScout further.\n', '.claude/skills/notes/SKILL.md': 'Notes.' };

// v1 installed through the real plan and apply, as a link install records it.
function installV1(workspace) {
  const source = tree(V1);
  const plan = buildPlan(workspace, source, { id: URL, reference: 'v1.0.0' });
  applyImport(workspace, source, decide(plan, Object.fromEntries(plan.items.map((i) => [i.id, 'add']))),
    { receipt: { now: '2026-09-01T09:00:00.000Z', run: 'v1', commit: C(1) } });
}

async function withUpdate(deps, fn) {
  const workspace = makeTempDir('upd-wire-ws-');
  const previousWorkspace = config.getWorkspace();
  config.setWorkspace(workspace);
  handlers.resetPackageCheckCache();
  const acquired = [];
  const previous = handlers.wireExtensionDeps({
    listTagCommits: async () => [{ name: 'v1.0.0', commit: C(1) }, { name: 'v2.0.0', commit: C(2) }],
    commitOf: () => C(2),
    pinKindOf: () => 'tag',
    ...deps,
    acquire: (source) => { acquired.push(source.reference); return deps.acquire ? deps.acquire(source) : tree(V2); },
  });
  try { await fn(workspace, acquired); } finally {
    handlers.wireExtensionDeps(previous);
    config.setWorkspace(previousWorkspace);
  }
}

describe('plan_package_update', () => {
  test('a newer release is acquired and offered as one review, held under a token', async () => {
    await withUpdate({}, async (workspace, acquired) => {
      installV1(workspace);
      const sock = captureWs();
      await handlers.handlePlanPackageUpdate({}, sock, { type: 'plan_package_update', source: URL, reference: 'v2.0.0' });
      const [reply] = sock.sent;
      assert.strictEqual(reply.type, 'package_update_plan');
      assert.deepStrictEqual([reply.id, reply.from, reply.to], [URL, 'v1.0.0', 'v2.0.0']);
      assert.deepStrictEqual(acquired, ['v2.0.0']);
      assert.deepStrictEqual(reply.groups['author-changed'].map((e) => e.id), ['agent:scout']);
      assert.strictEqual(reply.extension, null);
      // The review's projection reads the held snapshot through the token.
      handlers.handleEvaluatePackageDecisions({}, sock, { type: 'evaluate_package_decisions', token: reply.token, requestId: 'e', approval: reply.approval });
      assert.strictEqual(sock.sent[1].status, 'ready');
    });
  });

  test('an older or equal release is refused before anything is fetched', async () => {
    await withUpdate({}, async (workspace, acquired) => {
      installV1(workspace);
      const sock = captureWs();
      for (const reference of ['v1.0.0', 'v0.9.0', 'main']) {
        await handlers.handlePlanPackageUpdate({}, sock, { type: 'plan_package_update', source: URL, reference });
      }
      assert.deepStrictEqual(sock.sent.map((m) => [m.type, m.operation]), Array(3).fill(['package_install_error', 'package-update-plan']));
      assert.deepStrictEqual(acquired, [], 'git fetched nothing');
    });
  });

  test('a package that is not installed is refused by name', async () => {
    await withUpdate({}, async () => {
      const sock = captureWs();
      await handlers.handlePlanPackageUpdate({}, sock, { type: 'plan_package_update', source: URL, reference: 'v2.0.0' });
      assert.strictEqual(sock.sent[0].message, `No package from ${URL} is installed.`);
    });
  });

  test('a new version whose extension declares another name, or arrived other than at a tag, is refused and discarded', async () => {
    for (const [deps, pattern] of [
      [{ acquire: () => tree({ ...V2, 'rundock.json': MANIFEST('other-view', '2.0.0'), 'view/index.html': 'x' }) }, /declares the name "other-view"/],
      [{ pinKindOf: () => 'other', acquire: () => tree({ ...V2, 'rundock.json': MANIFEST('pack-view', '2.0.0'), 'view/index.html': 'x' }) }, /never installed from a branch/],
    ]) {
      let snapshot = null;
      const acquire = deps.acquire;
      await withUpdate({ ...deps, acquire: (s) => { snapshot = acquire(s); return snapshot; } }, async (workspace) => {
        installV1(workspace);
        write(workspace, '.rundock/extensions.json', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [
          { name: 'pack-view', version: '1.0.0', entry: 'view/index.html', match: '*.dataview.md', root: '.rundock/extensions/pack-view', source: { url: URL, reference: 'v1.0.0', commit: C(1) } },
        ] }));
        const sock = captureWs();
        await handlers.handlePlanPackageUpdate({}, sock, { type: 'plan_package_update', source: URL, reference: 'v2.0.0' });
        assert.strictEqual(sock.sent[0].type, 'package_install_error');
        assert.match(sock.sent[0].message, pattern);
        assert.strictEqual(fs.existsSync(snapshot), false, 'the acquired snapshot is discarded');
      });
    }
  });
});

// ---- Confirming an update ----
const { planExtensionInstall, installExtension } = require('../../lib/packages/extension-install.js');
const { setExtensionEnabled } = require('../../lib/packages/extension-manage.js');
const { readExtensionRecords } = require('../../lib/packages/extension-record.js');
const { installedPackages } = require('../../lib/packages/package-state.js');

const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
function treeOf(root) {
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
const ctx = () => ({ agents: { invalidateAgentCache() {}, flagRosterRefresh() {} }, workspace: { noteExtensionRecordsChanged() {} }, clients: [] });
const WITH_VIEW = (files, version, html) => ({ ...files, 'rundock.json': MANIFEST('pack-view', version), 'view/index.html': html });
const V2_EDITED = { ...V2, '.claude/skills/notes/SKILL.md': 'Notes, by the author.' };

// v1 with its extension, switched off, and the person's edit to the skill.
function installWithExtension(workspace) {
  installV1(workspace);
  const snap = tree(WITH_VIEW(V1, '1.0.0', '<main>v1</main>'));
  installExtension(workspace, snap, planExtensionInstall(workspace, snap, { url: URL, reference: 'v1.0.0', commit: C(1) }));
  setExtensionEnabled(workspace, 'pack-view', false);
  write(workspace, '.claude/skills/notes/SKILL.md', 'Notes, my way.');
}

async function planned(sock) {
  await handlers.handlePlanPackageUpdate({}, sock, { type: 'plan_package_update', source: URL, reference: 'v2.0.0' });
  return sock.sent[sock.sent.length - 1];
}

describe('confirm_package_update', () => {
  test('the extension, the items, the review copies, the backups and the receipt land together', async () => {
    await withUpdate({ acquire: () => tree(WITH_VIEW(V2_EDITED, '2.0.0', '<main>v2</main>')) }, async (workspace) => {
      installWithExtension(workspace);
      const oldScout = read(workspace, '.claude/agents/scout.md');
      const sock = captureWs();
      const plan = await planned(sock);
      assert.deepStrictEqual(plan.groups['both-changed'].map((e) => e.id), ['skill:notes']);
      // A tampered approval asking to overwrite the person's edit is ignored.
      const tampered = JSON.parse(JSON.stringify(plan.approval));
      const notes = tampered.items.find((i) => i.id === 'skill:notes');
      Object.assign(notes, { decision: 'overwrite', approvedDigest: notes.sourceDigest });
      handlers.handleConfirmPackageUpdate(ctx(), sock, { type: 'confirm_package_update', token: plan.token, requestId: 'c', approval: tampered });
      const reply = sock.sent[sock.sent.length - 1];
      assert.strictEqual(reply.type, 'package_update_result');
      assert.strictEqual(reply.status, 'ready');
      assert.match(read(workspace, '.claude/agents/scout.md'), /Scout further\./);
      assert.strictEqual(read(workspace, '.claude/skills/notes/SKILL.md'), 'Notes, my way.', 'the person\'s edit is kept');
      assert.strictEqual(read(workspace, '.rundock/package-updates/someone-pack/v2.0.0/.claude/skills/notes/SKILL.md'), 'Notes, by the author.');
      assert.strictEqual(read(workspace, '.rundock/package-updates/someone-pack/v1.0.0/.claude/agents/scout.md'), oldScout, 'what was replaced is backed up');
      assert.strictEqual(read(workspace, '.rundock/extensions/pack-view/view/index.html'), '<main>v2</main>');
      const [record] = readExtensionRecords(workspace);
      assert.deepStrictEqual([record.version, record.source.reference, record.enabled], ['2.0.0', 'v2.0.0', false], 'an extension that was off stays off');
      const receipt = JSON.parse(read(workspace, reply.receipt));
      assert.deepStrictEqual(receipt.update, { from: 'v1.0.0', to: 'v2.0.0' });
      assert.strictEqual(receipt.source.commit, C(2));
      assert.strictEqual(installedPackages(workspace).find((p) => p.id === URL).reference, 'v2.0.0');
    });
  });

  // The receipt lists each item the new version no longer
  // carries as kept, and the Packages card reads that entry as not carried
  // rather than as part of the package's current contents.
  test('an item the new version no longer carries is recorded as kept, left in place, and marked on the card', async () => {
    const { packageCards } = require('../../lib/packages/package-state.js');
    await withUpdate({ acquire: () => tree({ '.claude/agents/scout.md': V2['.claude/agents/scout.md'] }) }, async (workspace) => {
      installV1(workspace);
      const sock = captureWs();
      const plan = await planned(sock);
      assert.deepStrictEqual((plan.groups.retired || []).map((e) => e.id), ['skill:notes']);
      handlers.handleConfirmPackageUpdate(ctx(), sock, { type: 'confirm_package_update', token: plan.token, requestId: 'c' });
      const reply = sock.sent[sock.sent.length - 1];
      assert.strictEqual(reply.status, 'ready');
      assert.strictEqual(read(workspace, '.claude/skills/notes/SKILL.md'), 'Notes.', 'kept where it is');
      const receipt = JSON.parse(read(workspace, reply.receipt));
      const notes = receipt.items.find((i) => i.id === 'skill:notes');
      assert.deepStrictEqual(notes, { id: 'skill:notes', kind: 'skill', destination: '.claude/skills/notes', outcome: 'kept', inPackage: false });
      assert.strictEqual(receipt.items.find((i) => i.id === 'agent:scout').outcome, 'written');
      const carried = Object.fromEntries(packageCards(workspace)[0].items.map((i) => [i.id, i.carried]));
      assert.deepStrictEqual(carried, { 'agent:scout': true, 'skill:notes': false });
    });
  });

  test('a fault at any step leaves the workspace exactly as it was, extension included', async () => {
    let steps = 0;
    await withUpdate({ acquire: () => tree(WITH_VIEW(V2_EDITED, '2.0.0', '<main>v2</main>')), afterStep: () => { steps += 1; } }, async (workspace) => {
      installWithExtension(workspace);
      const sock = captureWs();
      const plan = await planned(sock);
      handlers.handleConfirmPackageUpdate(ctx(), sock, { type: 'confirm_package_update', token: plan.token, requestId: 'c' });
    });
    assert.ok(steps > 4);
    for (let boundary = 1; boundary <= steps; boundary++) {
      let completed = 0;
      await withUpdate({
        acquire: () => tree(WITH_VIEW(V2_EDITED, '2.0.0', '<main>v2</main>')),
        afterStep: () => { completed += 1; if (completed === boundary) throw new Error('injected fault'); },
      }, async (workspace) => {
        installWithExtension(workspace);
        const sock = captureWs();
        const plan = await planned(sock);
        const before = treeOf(workspace);
        handlers.handleConfirmPackageUpdate(ctx(), sock, { type: 'confirm_package_update', token: plan.token, requestId: 'c' });
        assert.strictEqual(sock.sent[sock.sent.length - 1].type, 'package_install_error');
        const after = treeOf(workspace);
        assert.deepStrictEqual(after, before, `after step ${boundary} of ${steps}`);
      });
    }
  });

  test('refused while a routine of an agent it would rewrite is running, and nothing moves', async () => {
    await withUpdate({ runningRuns: () => [{ agent: 'scout', routine: 'Morning briefing' }] }, async (workspace) => {
      installV1(workspace);
      const sock = captureWs();
      const plan = await planned(sock);
      const before = treeOf(workspace);
      handlers.handleConfirmPackageUpdate(ctx(), sock, { type: 'confirm_package_update', token: plan.token, requestId: 'c' });
      const reply = sock.sent[sock.sent.length - 1];
      assert.strictEqual(reply.code, 'routine-running');
      assert.match(reply.message, /Morning briefing/);
      assert.deepStrictEqual(treeOf(workspace), before);
    });
  });

  test('the token dies with its use', async () => {
    await withUpdate({}, async (workspace) => {
      installV1(workspace);
      const sock = captureWs();
      const plan = await planned(sock);
      handlers.handleConfirmPackageUpdate(ctx(), sock, { type: 'confirm_package_update', token: plan.token, requestId: 'c' });
      handlers.handleConfirmPackageUpdate(ctx(), sock, { type: 'confirm_package_update', token: plan.token, requestId: 'd' });
      assert.match(sock.sent[sock.sent.length - 1].message, /nothing is awaiting this confirmation/);
    });
  });
});

describe('the review names the saved files and the new powers', () => {
  test('each kept item names where its author version is saved, and that is where it lands', async () => {
    await withUpdate({ acquire: () => tree(V2_EDITED) }, async (workspace) => {
      installV1(workspace);
      write(workspace, '.claude/skills/notes/SKILL.md', 'Notes, my way.');
      const sock = captureWs();
      const plan = await planned(sock);
      const [entry] = plan.groups['both-changed'];
      assert.strictEqual(entry.saved, '.rundock/package-updates/someone-pack/v2.0.0/.claude/skills/notes');
      handlers.handleConfirmPackageUpdate(ctx(), sock, { type: 'confirm_package_update', token: plan.token, requestId: 'c' });
      assert.strictEqual(read(workspace, `${entry.saved}/SKILL.md`), 'Notes, by the author.');
    });
  });

  test('a privilege the new extension asks for that the installed one did not is named', async () => {
    const WRITES = (files) => ({ ...files, 'rundock.json': JSON.stringify({ name: 'pack-view', version: '2.0.0', extension: { entry: 'view/index.html', match: '*.dataview.md', writes: true } }), 'view/index.html': 'x' });
    await withUpdate({ acquire: () => tree(WRITES(V2)) }, async (workspace) => {
      installV1(workspace);
      const snap = tree(WITH_VIEW(V1, '1.0.0', 'v1'));
      installExtension(workspace, snap, planExtensionInstall(workspace, snap, { url: URL, reference: 'v1.0.0', commit: C(1) }));
      const plan = await planned(captureWs());
      assert.deepStrictEqual(plan.extension.added, { writes: true, sources: false, asks: [] });
    });
  });
});
