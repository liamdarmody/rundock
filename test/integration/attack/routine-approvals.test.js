'use strict';
// Attack tests: a routine's approval counts only where it was given.
//
// An approval used to be a field in the agent file, so it travelled with the
// file: a copied folder, a cloned repository or an agent editing its own file
// arrived with its routines already approved, and the scheduler ran anything
// overdue the moment the workspace opened. Now this install keeps its own
// record of what was approved, in which workspace, and the scheduler asks it.
//
// Every scenario opens a workspace through the real open path and drives the
// real tick at a fixed instant, then reads what the tick said and did. Each
// "nothing ran" has a control that does run, in a workspace this install
// opened before, so absence means the rule rather than a broken scheduler.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../../helpers/harness.js');
const { agentFile, makeTempDir } = require('../../helpers/workspace.js');
const scheduler = require('../../../lib/scheduler.js');
const { computePlanHash, normalizeRoutine, parseRoutineBlocks } = require('../../../lib/agents/routines.js');
const { extractFrontmatterText } = require('../../../lib/agents/discovery.js');

// Wednesday 2026-07-01, local time: every routine here is due daily at 08:00.
const WEDNESDAY = new Date(2026, 6, 1, 9, 30, 0);
const THURSDAY = new Date(2026, 6, 2, 8, 30, 0);
const clock = { at: WEDNESDAY };
let prevDeps = null;
let client;

before(async () => {
  await h.boot();
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
  client = await h.connect();
});
after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

// An agent file whose routine carries an approval that matches its plan,
// exactly as one approved in the workspace it came from does.
function approvedAgent(slug, routineName, prompt) {
  const draft = agentFile({ name: slug, type: 'specialist', order: 1, routines: [{ name: routineName, schedule: 'every day at 08:00', prompt, enabled: true, paused: false, runOn: 'local' }] });
  const [raw] = parseRoutineBlocks(extractFrontmatterText(draft));
  const hash = computePlanHash(normalizeRoutine(raw));
  return agentFile({ name: slug, type: 'specialist', order: 1, routines: [{ name: routineName, schedule: 'every day at 08:00', prompt, enabled: true, paused: false, runOn: 'local', planHash: hash, planApprovedHash: hash }] });
}

// A routine written before approvals existed: no approval key at all.
function keylessAgent(slug, routineName, prompt) {
  return agentFile({ name: slug, type: 'specialist', order: 1, routines: [{ name: routineName, schedule: 'every day at 08:00', prompt, enabled: true }] });
}

function workspaceWith(agents, { seenHere = false } = {}) {
  const dir = makeTempDir('rundock-approval-ws-');
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  for (const [slug, content] of Object.entries(agents)) fs.writeFileSync(path.join(dir, '.claude', 'agents', `${slug}.md`), content);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Approval workspace\n');
  // What an earlier version of Rundock leaves behind after opening a
  // workspace at this path on this machine: the workspace's own record of
  // where it was opened, and this install's list of recent workspaces from
  // before it kept approvals itself (lib/agents/approval-store.js).
  if (seenHere) {
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.rundock', 'state.json'), JSON.stringify({ workspacePath: dir }));
    const store = require('../../../lib/agents/approval-store.js');
    if (typeof store.markRecentBeforeStore === 'function') store.markRecentBeforeStore(dir);
  }
  return dir;
}

// Open through the real path; resolve the roster and the held routines.
async function open(dir) {
  const since = client.messages.length;
  client.send({ type: 'set_workspace', path: dir });
  await client.waitFor((m) => m.type === 'workspace_set' && m.path === dir, { since, label: `open ${dir}` });
  const { msg: roster } = await client.waitFor((m) => m.type === 'agents' && m.workspace === dir, { since, label: 'roster' });
  const held = await client.waitFor((m) => m.type === 'held_routines', { since, timeout: 3000, label: 'held routines' })
    .then(({ msg }) => msg, () => null);
  return { roster, held };
}

function routineOf(roster, name) {
  for (const agent of roster.agents) for (const r of agent.routines || []) if (r.name === name) return r;
  return null;
}

// One tick of the real scheduler at `at`, with what it said.
function tick(t, at) {
  clock.at = at;
  const logs = [];
  const realLog = console.log;
  h.internal.stopScheduler();
  t.mock.timers.enable({ apis: ['setInterval'] });
  console.log = (...args) => logs.push(args.join(' '));
  try {
    h.internal.startScheduler();
    t.mock.timers.tick(60_000);
  } finally {
    console.log = realLog;
    h.internal.stopScheduler();
    t.mock.timers.reset();
  }
  return logs;
}
const ran = (logs, name) => logs.some((l) => l.includes('Running routine') && l.includes(name));
const refusedForApproval = (logs, name) => logs.some((l) => l.includes('Not running routine') && l.includes(name) && l.includes('plan not approved'));

describe('a workspace this install has never opened', () => {
  test('17. copied agent files with approved, overdue routines: nothing runs, Routines shows them waiting, the strip names them', async (t) => {
    const dir = workspaceWith({ lea: approvedAgent('lea', 'copied-triage', 'copied triage body') });
    const { roster, held } = await open(dir);
    const logs = tick(t, WEDNESDAY);
    assert.ok(!ran(logs, 'copied-triage'), 'the copied routine did not run');
    assert.ok(refusedForApproval(logs, 'copied-triage'));
    assert.strictEqual(routineOf(roster, 'copied-triage').refusal, 'approval', 'Routines shows it waiting');
    assert.ok(held && held.routines.some((r) => r.name === 'copied-triage'), 'the strip names it');
  });

  test('18. the whole folder copied, .rundock included: nothing runs', async (t) => {
    const original = workspaceWith({ lea: approvedAgent('lea', 'whole-copy', 'whole copy body') }, { seenHere: true });
    fs.writeFileSync(path.join(original, '.rundock', 'approval-feature-ran'), 'x\n');
    const copy = makeTempDir('rundock-approval-copy-');
    fs.cpSync(original, copy, { recursive: true });
    await open(copy);
    const logs = tick(t, WEDNESDAY);
    assert.ok(!ran(logs, 'whole-copy'));
    assert.ok(refusedForApproval(logs, 'whole-copy'));
  });

  test('19. a routine with no approval key, in a cloned folder with no marker: held, not waved through', async (t) => {
    const dir = workspaceWith({ kit: keylessAgent('kit', 'cloned-keyless', 'cloned keyless body') });
    const { roster } = await open(dir);
    const logs = tick(t, WEDNESDAY);
    assert.ok(!ran(logs, 'cloned-keyless'));
    assert.strictEqual(routineOf(roster, 'cloned-keyless').refusal, 'approval');
    assert.match(fs.readFileSync(path.join(dir, '.claude', 'agents', 'kit.md'), 'utf-8'), /planApprovedHash: pending/,
      'and the file is not stamped approved either: a missing key is never read as consent here');
  });
});

describe('a workspace this install opened before', () => {
  test('23. upgrade: a workspace opened here before keeps its approved and its pre-approval routines running, with no strip', async (t) => {
    const dir = workspaceWith({
      lea: approvedAgent('lea', 'upgrade-approved', 'upgrade approved body'),
      kit: keylessAgent('kit', 'upgrade-keyless', 'upgrade keyless body'),
    }, { seenHere: true });
    const { held } = await open(dir);
    const logs = tick(t, WEDNESDAY);
    assert.ok(ran(logs, 'upgrade-approved'), 'the approved routine keeps running');
    assert.ok(ran(logs, 'upgrade-keyless'), 'and so does the one written before approvals existed');
    assert.ok(!held || held.routines.length === 0, 'no strip');
  });

  test('20. an agent writes a correct approval into its own file: still not approved', async (t) => {
    const dir = workspaceWith({ lea: approvedAgent('lea', 'control-routine', 'control body') }, { seenHere: true });
    await open(dir);
    // After the workspace is open, the agent adds a routine to its own file,
    // with an approval it computed itself.
    fs.writeFileSync(path.join(dir, '.claude', 'agents', 'self.md'), approvedAgent('self', 'self-approved', 'self approved body'));
    require('../../../lib/agents/discovery.js').invalidateAgentCache();
    const logs = tick(t, WEDNESDAY);
    assert.ok(ran(logs, 'control-routine'), 'control: the routine approved here runs');
    assert.ok(!ran(logs, 'self-approved'), 'the self-approved one does not');
    assert.ok(refusedForApproval(logs, 'self-approved'));
  });
});

describe('the strip', () => {
  test('24. Allow: no run on the click; the routine runs at its next slot', async (t) => {
    const dir = workspaceWith({ lea: approvedAgent('lea', 'allowed-later', 'allowed later body') });
    const { held } = await open(dir);
    assert.ok(held && held.routines.some((r) => r.name === 'allowed-later'));
    const since = client.messages.length;
    client.send({ type: 'allow_held_routines' });
    const { msg: after } = await client.waitFor((m) => m.type === 'held_routines', { since, label: 'held after allow' });
    assert.deepStrictEqual(after.routines, []);
    const sameDay = tick(t, WEDNESDAY);
    assert.ok(!ran(sameDay, 'allowed-later'), 'no catch-up run on the click');
    assert.ok(!refusedForApproval(sameDay, 'allowed-later'), 'and it is no longer waiting for approval');
    const nextDay = tick(t, THURSDAY);
    assert.ok(ran(nextDay, 'allowed-later'), 'it runs at its next slot');
  });

  test('24. Dismiss: held, and the strip does not return', async (t) => {
    const dir = workspaceWith({ lea: approvedAgent('lea', 'dismissed-held', 'dismissed held body') });
    await open(dir);
    const since = client.messages.length;
    client.send({ type: 'dismiss_held_routines' });
    await client.waitFor((m) => m.type === 'held_routines' && m.routines.length === 0, { since, label: 'held after dismiss' });
    await open(h.workspaceDir);
    const { held } = await open(dir);
    assert.ok(!held || held.routines.length === 0, 'the strip does not return');
    const logs = tick(t, WEDNESDAY);
    assert.ok(!ran(logs, 'dismissed-held'), 'still held');
  });
});

describe('approvals given here', () => {
  async function approveHere(dir, agentId, name) {
    await open(dir);
    const since = client.messages.length;
    client.send({ type: 'approve_routine_plan', agentId, name, occurrence: 0 });
    await client.waitFor((m) => m.type === 'routine_plan_approved' && m.name === name, { since, label: 'approved' });
  }

  test('25. moved (the old path is gone): approvals kept', async (t) => {
    const dir = workspaceWith({ lea: keylessAgent('lea', 'moved-routine', 'moved body') }, { seenHere: false });
    // Held on arrival, so only the tap below can be what lets it run.
    await approveHere(dir, 'lea', 'moved-routine');
    // Closed (another workspace opened) before it is moved, as a person moves
    // a folder: a workspace still open is still being written to.
    await open(h.workspaceDir);
    const moved = `${dir}-moved`;
    fs.renameSync(dir, moved);
    await open(moved);
    const logs = tick(t, THURSDAY);
    assert.ok(ran(logs, 'moved-routine'), logs.join('\n'));
  });

  test('25. copied (the old path still there): not kept', async (t) => {
    const dir = workspaceWith({ lea: keylessAgent('lea', 'copied-approved', 'copied approved body') }, { seenHere: false });
    await approveHere(dir, 'lea', 'copied-approved');
    const copy = `${dir}-copy`;
    fs.cpSync(dir, copy, { recursive: true });
    await open(copy);
    const logs = tick(t, THURSDAY);
    assert.ok(!ran(logs, 'copied-approved'));
    assert.ok(refusedForApproval(logs, 'copied-approved'));
  });

  test('22. a package installed through its card runs there; a copy of that workspace holds it', async (t) => {
    const { buildPlan, decide } = require('../../../lib/packages/import-plan.js');
    const { applyImport } = require('../../../lib/packages/import-apply.js');
    const dir = workspaceWith({}, { seenHere: true });
    await open(dir);
    clock.at = WEDNESDAY; // the moment the card is agreed
    const src = makeTempDir('rundock-approval-pkg-');
    fs.mkdirSync(path.join(src, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(src, '.claude', 'agents', 'scout.md'),
      '---\nname: scout\nroutines:\n  - name: package-routine\n    schedule: every day at 08:00\n    prompt: package routine body\n    enabled: true\n---\n\nYou help.\n');
    const plan = buildPlan(dir, src, { id: 'https://github.com/someone/pack', reference: 'v1.0.0' });
    const approval = decide(plan, Object.fromEntries(plan.items.map((i) => [i.id, 'add'])));
    assert.strictEqual(applyImport(dir, src, approval, { receipt: { now: '2026-07-01T09:00:00.000Z', run: 'v1' } }).status, 'ready');
    require('../../../lib/agents/discovery.js').invalidateAgentCache();
    const there = tick(t, THURSDAY);
    assert.ok(ran(there, 'package-routine'), 'it runs in the workspace where the card was agreed:\n' + there.join('\n'));
    const copy = `${dir}-pkgcopy`;
    fs.cpSync(dir, copy, { recursive: true });
    await open(copy);
    clock.at = new Date(2026, 6, 3, 8, 30, 0);
    const elsewhere = tick(t, clock.at);
    assert.ok(!ran(elsewhere, 'package-routine'), 'a copy holds it');
  });
});

describe('bridges from a file an agent can write back into an approval', () => {
  test('S1. a workspace whose own state file claims it was opened here before is still unseen', async (t) => {
    // The state file lives inside the workspace, so a repository can ship one
    // naming the place it will be cloned to. Only this install's own record
    // of where it has opened workspaces counts.
    const dir = workspaceWith({ lea: approvedAgent('lea', 'crafted-state', 'crafted state body') });
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.rundock', 'state.json'), JSON.stringify({ workspacePath: dir }));
    const { held } = await open(dir);
    const logs = tick(t, WEDNESDAY);
    assert.ok(!ran(logs, 'crafted-state'));
    assert.ok(held && held.routines.some((r) => r.name === 'crafted-state'), 'and the strip names it');
  });

  test('S2. a package update never turns an approval an agent wrote into its file into a real one', async (t) => {
    const { buildPlan, decide } = require('../../../lib/packages/import-plan.js');
    const { applyImport } = require('../../../lib/packages/import-apply.js');
    const { installedPackages } = require('../../../lib/packages/package-state.js');
    const { buildUpdatePlan } = require('../../../lib/packages/package-update-plan.js');
    const URL = 'https://github.com/someone/pack-s2';
    const dir = workspaceWith({}, { seenHere: true });
    await open(dir);
    clock.at = WEDNESDAY;
    const src = makeTempDir('rundock-s2-src-');
    fs.mkdirSync(path.join(src, '.claude', 'agents'), { recursive: true });
    const authored = (version) => `---\nname: scout\ndescription: ${version}\nroutines:\n  - name: quiet-routine\n    schedule: every day at 08:00\n    prompt: quiet routine body\n    enabled: false\n---\n\nYou help.\n`;
    fs.writeFileSync(path.join(src, '.claude', 'agents', 'scout.md'), authored('v1'));
    const plan = buildPlan(dir, src, { id: URL, reference: 'v1.0.0' });
    assert.strictEqual(applyImport(dir, src, decide(plan, Object.fromEntries(plan.items.map((i) => [i.id, 'add']))), { receipt: { now: '2026-07-01T09:00:00.000Z', run: 'v1' } }).status, 'ready');
    // The agent switches its own routine on and writes itself an approval
    // that matches the plan.
    const file = path.join(dir, '.claude', 'agents', 'scout.md');
    const text = fs.readFileSync(file, 'utf-8');
    const [raw] = parseRoutineBlocks(extractFrontmatterText(text));
    const hash = computePlanHash(normalizeRoutine(raw));
    fs.writeFileSync(file, text.replace('enabled: false', 'enabled: true').replace(/planApprovedHash: \S+/, `planApprovedHash: ${hash}`));
    // The author ships an update that leaves that routine as it was.
    fs.writeFileSync(path.join(src, '.claude', 'agents', 'scout.md'), authored('v2'));
    const [pkg] = installedPackages(dir);
    const update = buildUpdatePlan(dir, src, pkg, { url: URL, reference: 'v2.0.0' });
    assert.strictEqual(applyImport(dir, src, update.approval, { receipt: { now: '2026-07-01T09:30:00.000Z', run: 'v2' } }).status, 'ready');
    require('../../../lib/agents/discovery.js').invalidateAgentCache();
    const logs = tick(t, THURSDAY);
    assert.ok(!ran(logs, 'quiet-routine'), 'the self-written approval was carried, and still grants nothing');
    assert.ok(refusedForApproval(logs, 'quiet-routine'));
  });

  test('S5. Allow approves the plan as it was when the strip named it, not one changed since', async (t) => {
    const dir = workspaceWith({ lea: approvedAgent('lea', 'changed-after', 'the plan the strip named') });
    const { held } = await open(dir);
    assert.ok(held && held.routines.some((r) => r.name === 'changed-after'));
    // Between the strip appearing and the click, the plan is rewritten.
    const file = path.join(dir, '.claude', 'agents', 'lea.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('the plan the strip named', 'a different plan entirely'));
    require('../../../lib/agents/discovery.js').invalidateAgentCache();
    const since = client.messages.length;
    client.send({ type: 'allow_held_routines' });
    await client.waitFor((m) => m.type === 'held_routines', { since, label: 'held after allow' });
    const logs = tick(t, THURSDAY);
    assert.ok(!ran(logs, 'changed-after'), 'the changed plan was not approved');
    assert.ok(refusedForApproval(logs, 'changed-after'), 'it waits in Routines for its own approval');
  });
});
