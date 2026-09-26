'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const { decide, buildPlan } = require('../../lib/packages/import-plan.js');
const { journalPath } = require('../../lib/workspace/atomic-write.js');
const { digestFile } = require('../../lib/packages/import-apply.js');
const { authoredDigest } = require('../../lib/packages/package-fingerprint.js');
const config = require('../../lib/config.js');
const { makeTempDir } = require('../helpers/workspace.js');

const SOURCE = { id: 'github.com/example/pack', reference: 'v1.0.0' };
const RECEIPTS = '.rundock/receipts';

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

// The complete tree as one comparable value.
function tree(root, current = root) {
  const result = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) {
      const children = tree(root, absolute);
      if (children.length === 0) result.push(`${relative}/`);
      else result.push(...children);
    } else {
      result.push(`${relative}:${fs.readFileSync(absolute).toString('base64')}`);
    }
  }
  return result;
}

function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}

// Every request travels the real dispatch table as JSON, exactly as a client
// would send it, and every reply is read back from the wire capture. The
// context carries the one root capability the apply path reaches for, the
// roster cache cascade, inert here; the invalidation test below hands in a
// counting one, and the composition-root wiring is proven in
// test/unit/protocol-handlers-lib.test.js against the real cascade.
function dispatchJson(type, payload, ctx = { agents: { invalidateAgentCache() {}, flagRosterRefresh() {} } }) {
  const dispatch = buildDispatch();
  const ws = captureWs();
  dispatch[type](ctx, ws, JSON.parse(JSON.stringify({ type, ...payload })));
  assert.strictEqual(ws.sent.length, 1);
  return ws.sent[0];
}

const AGENT_TEXT = '---\nname: writer\n---\n\nWrite things.\n';

function fixture() {
  const workspace = makeTempDir('proto-ws-');
  const sourceRoot = makeTempDir('proto-src-');
  write(workspace, 'notes/keep.md', 'foreign');
  write(workspace, '.claude/skills/writer/SKILL.md', 'old skill');
  write(sourceRoot, '.claude/agents/scribe.md', AGENT_TEXT);
  write(sourceRoot, '.claude/skills/writer/SKILL.md', 'new skill');
  config.setWorkspace(workspace);
  return { workspace, sourceRoot };
}

function planVia(sourceRoot) {
  const reply = dispatchJson('plan_package_import', { sourcePath: sourceRoot, source: SOURCE });
  assert.strictEqual(reply.type, 'package_import_plan');
  return reply.plan;
}

describe('the protocol boundary', () => {
  const original = config.getWorkspace();
  test.after(() => config.setWorkspace(original));

  test('plan and apply round-trip both kinds through the real dispatch table', () => {
    const { workspace, sourceRoot } = fixture();
    const plan = planVia(sourceRoot);
    assert.deepStrictEqual(plan.items.map((i) => [i.id, i.collision]),
      [['agent:scribe', false], ['skill:writer', true]]);
    const approval = decide(plan, { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    const reply = dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval });
    assert.strictEqual(reply.type, 'package_import_result');
    assert.strictEqual(reply.status, 'ready');
    assert.deepStrictEqual(reply.writes.map((w) => w.id), ['agent:scribe', 'skill:writer']);
    assert.strictEqual(reply.written.length, 3); // two destinations plus the receipt
    assert.match(fs.readFileSync(path.join(workspace, '.claude/agents/scribe.md'), 'utf8'), /^source: /m);
    assert.strictEqual(fs.readFileSync(path.join(workspace, '.claude/skills/writer/SKILL.md'), 'utf8'), 'new skill');
    // Exactly one receipt, whose entries equal the reply's outcomes.
    const receipts = fs.readdirSync(path.join(workspace, RECEIPTS));
    assert.strictEqual(receipts.length, 1);
    assert.strictEqual(reply.receipt, `${RECEIPTS}/${receipts[0]}`);
    const receipt = JSON.parse(fs.readFileSync(path.join(workspace, RECEIPTS, receipts[0]), 'utf8'));
    assert.deepStrictEqual(receipt.source, SOURCE);
    assert.deepStrictEqual(receipt.items.map((i) => [i.id, i.outcome]),
      [['agent:scribe', 'written'], ['skill:writer', 'written']]);
  });

  test('a successful plan is the plan module\'s output verbatim and writes nothing anywhere', () => {
    const { workspace, sourceRoot } = fixture();
    const wsBefore = tree(workspace);
    const srcBefore = tree(sourceRoot);
    const reply = dispatchJson('plan_package_import', { sourcePath: sourceRoot, source: SOURCE });
    assert.strictEqual(reply.type, 'package_import_plan');
    // Deep-equal to a JSON round trip of the real producer: any field the
    // handler adds, drops or reshapes fails here.
    const direct = JSON.parse(JSON.stringify(buildPlan(workspace, sourceRoot, SOURCE)));
    assert.deepStrictEqual(reply.plan, direct);
    assert.deepStrictEqual(tree(workspace), wsBefore);
    assert.deepStrictEqual(tree(sourceRoot), srcBefore);
  });

  // [name, build(sourceRoot), message]: every discovery refusal class the
  // plan path can raise, each surfacing as a structured error.
  const PLAN_REFUSALS = [
    ['a non-canonical skill name', (root) => write(root, '.claude/skills/Bad Name/SKILL.md', 'x'), /not a canonical skill name/, 'package-refused'],
    ['a non-canonical agent name', (root) => write(root, '.claude/agents/Not A Slug.md', AGENT_TEXT), /not a canonical agent file name/, 'package-refused'],
    ['a symlink in the source', (root) => {
      write(root, 'real.md', AGENT_TEXT);
      fs.symlinkSync(path.join(root, 'real.md'), path.join(root, '.claude/agents/link.md'));
    }, /is a symlink/, 'package-refused'],
    ['unterminated agent frontmatter', (root) => write(root, '.claude/agents/broken.md', '---\nname: broken\n'), /never closes/, 'package-refused'],
    // Returns its own root: emptiness cannot be added to a populated source.
    ['an empty package', () => {
      const empty = makeTempDir('proto-empty-');
      fs.mkdirSync(path.join(empty, '.claude'), { recursive: true });
      return { probeRoot: empty };
    }, /no agents and no skills/, 'empty-package'],
  ];

  for (const [name, build, message, code] of PLAN_REFUSALS) {
    test(`${name} surfaces as a structured plan error with the workspace unchanged`, () => {
      const { workspace, sourceRoot } = fixture();
      const returned = build(sourceRoot);
      const probe = returned && returned.probeRoot ? returned.probeRoot : sourceRoot;
      const before = tree(workspace);
      const reply = dispatchJson('plan_package_import', { sourcePath: probe, source: SOURCE });
      assert.strictEqual(reply.type, 'package_import_error');
      assert.strictEqual(reply.operation, 'plan');
      assert.match(reply.message, message);
      assert.doesNotMatch(reply.message, /\n\s+at /); // a message, not a stack trace
      // The concrete code each real refusal carries, so clients classify
      // from it and never from message prose; red if refuse() stops
      // attaching codes, the default is renamed, or fail() drops the field.
      assert.strictEqual(reply.code, code);
      assert.deepStrictEqual(tree(workspace), before);
    });
  }

  for (const [name, bad] of [['omitted', {}], ['empty', { sourcePath: '' }], ['non-string', { sourcePath: 7 }]]) {
    test(`an ${name} sourcePath refuses both operations before any filesystem work`, () => {
      const { workspace } = fixture();
      const before = tree(workspace);
      for (const op of ['plan', 'apply']) {
        const reply = dispatchJson(`${op}_package_import`, { ...bad, source: SOURCE, approval: {} });
        assert.strictEqual(reply.type, 'package_import_error');
        assert.strictEqual(reply.operation, op);
        assert.match(reply.message, /sourcePath is required/);
      }
      assert.deepStrictEqual(tree(workspace), before);
    });
  }

  test('evaluate_package_decisions refuses with one stamped reply when no workspace is open, echoing the requestId', () => {
    config.setWorkspace(null);
    const reply = dispatchJson('evaluate_package_decisions', { requestId: 'r3', sourcePath: '/nowhere', approval: {} });
    // The echoed id is what lets the model's identity check match this
    // refusal to the request that asked, rather than drop it as foreign.
    assert.deepStrictEqual([reply.type, reply.operation, reply.requestId], ['package_import_error', 'evaluate', 'r3']);
    assert.strictEqual(reply.message, 'No workspace is open.');
  });

  test('a replayed identical approval performs zero writes and writes no second receipt', () => {
    const { workspace, sourceRoot } = fixture();
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval });
    const after = tree(workspace);
    const replay = dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval });
    assert.strictEqual(replay.status, 'ready');
    assert.deepStrictEqual(replay.written, []);
    assert.strictEqual(replay.receipt, null);
    assert.deepStrictEqual(tree(workspace), after);
    assert.strictEqual(fs.readdirSync(path.join(workspace, RECEIPTS)).length, 1);
  });

  test('an apply that lands writes tells the roster cache cascade once; a replay and an all-skip apply tell it nothing', () => {
    // The cascade is how the roster the server serves learns an agent file
    // changed, so an apply that landed writes must tell it exactly as
    // save_agent does. The other direction matters as much: a replay and an
    // all-skip apply move no agent or skill, and tearing the caches down for
    // them would make every import a refresh whether it changed anything or
    // not.
    // The roster flag rides the same rule, for a different reader. The cascade
    // serves the next request; the flag serves a conversation that is already
    // underway, whose orchestrator was given its team in a system prompt built
    // before the package existed. Flagging does not wake anything: it sets a
    // bit that is spent when a follow-up next arrives in that conversation,
    // which respawns it over --resume with the roster it should have had.
    // Without it an imported agent is visible in Team and undelegatable in the
    // conversation the person is sitting in.
    const counting = () => {
      const ctx = {
        calls: 0,
        flags: 0,
        agents: {
          invalidateAgentCache() { ctx.calls += 1; },
          flagRosterRefresh() { ctx.flags += 1; },
        },
      };
      return ctx;
    };
    const { sourceRoot } = fixture();
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    const landing = counting();
    assert.strictEqual(dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval }, landing).status, 'ready');
    assert.strictEqual(landing.calls, 1, 'a landed import is an agent write, so the cascade is told exactly once');
    assert.strictEqual(landing.flags, 1, 'a landed import changed the team, so live orchestrators are flagged exactly once');
    const replaying = counting();
    const replay = dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval }, replaying);
    assert.deepStrictEqual([replay.status, replay.written], ['ready', []]);
    assert.strictEqual(replaying.calls, 0, 'a replay writes nothing, so no cache is torn down for it');
    assert.strictEqual(replaying.flags, 0, 'a replay changed no team, so no conversation is respawned for it');
    const second = fixture();
    const skipAll = decide(planVia(second.sourceRoot), { 'agent:scribe': 'skip', 'skill:writer': 'skip' });
    const skipping = counting();
    assert.strictEqual(dispatchJson('apply_package_import', { sourcePath: second.sourceRoot, approval: skipAll }, skipping).status, 'ready');
    assert.strictEqual(skipping.calls, 0, 'an all-skip apply lands no agent or skill, so nothing needs refreshing');
    assert.strictEqual(skipping.flags, 0, 'an all-skip apply changed no team, so nothing is flagged');
  });

  test('an all-skip apply writes a receipt recording every decision', () => {
    // The zero-write shortcut governs destination files, never the decision
    // record: a person who skipped everything still confirmed decisions, and
    // that is what a receipt records. Only a pure replay, every item already
    // at its approved bytes, writes none: the replay test above holds that.
    const { workspace, sourceRoot } = fixture();
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'skip', 'skill:writer': 'skip' });
    const before = tree(workspace);
    const reply = dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval });
    assert.strictEqual(reply.status, 'ready');
    assert.deepStrictEqual(reply.writes, []);
    assert.ok(reply.receipt, 'the decision record is written even though nothing reached a destination');
    const receipt = JSON.parse(fs.readFileSync(path.join(workspace, reply.receipt), 'utf8'));
    assert.deepStrictEqual(receipt.items.map((i) => [i.id, i.decision, i.outcome]),
      [['agent:scribe', 'skip', 'skipped'], ['skill:writer', 'skip', 'skipped']]);
    const added = tree(workspace).filter((line) => !before.includes(line));
    assert.deepStrictEqual(added.map((line) => line.split(':')[0]), [reply.receipt],
      'the receipt is the transaction\'s one write');
  });

  test('an evaluate_package_decisions dispatch leaves the complete tree byte-identical, receipts included', () => {
    const { workspace, sourceRoot } = fixture();
    // An apply first, so there is a receipts directory to be left alone, and
    // an interrupted-transaction recovery would have something to do if the
    // evaluate path ever ran one.
    dispatchJson('apply_package_import', {
      sourcePath: sourceRoot, approval: decide(planVia(sourceRoot), { 'agent:scribe': 'skip', 'skill:writer': 'skip' }),
    });
    assert.strictEqual(fs.readdirSync(path.join(workspace, RECEIPTS)).length, 1);
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    const before = tree(workspace);
    const reply = dispatchJson('evaluate_package_decisions', { requestId: 'r1', sourcePath: sourceRoot, approval });
    assert.strictEqual(reply.type, 'package_import_result');
    assert.deepStrictEqual([reply.operation, reply.requestId, reply.status], ['evaluate', 'r1', 'ready']);
    assert.strictEqual(reply.writes.length, 2, 'the evaluation has writes to make, and makes none of them');
    assert.strictEqual('written' in reply, false);
    assert.deepStrictEqual(tree(workspace), before);
  });

  test('the evaluate handler and applyImport reach the evaluator through one function, and agree', () => {
    const { workspace, sourceRoot } = fixture();
    const { evaluateApproval, applyImport } = require('../../lib/packages/import-apply.js');
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    const buckets = (r) => JSON.parse(JSON.stringify(
      { status: r.status, writes: r.writes, unchanged: r.unchanged, skipped: r.skipped, blocked: r.blocked, stale: r.stale }));
    const direct = buckets(evaluateApproval(workspace, sourceRoot, approval));
    assert.strictEqual(direct.writes.length, 2);
    const viaHandler = dispatchJson('evaluate_package_decisions', { requestId: 'r2', sourcePath: sourceRoot, approval });
    assert.deepStrictEqual(buckets(viaHandler), direct);
    assert.deepStrictEqual(buckets(applyImport(workspace, sourceRoot, approval, { receipt: {} })), direct);
  });

  test('the receipt is the complete record of a mixed-outcome apply', () => {
    const workspace = makeTempDir('proto-ws-');
    const sourceRoot = makeTempDir('proto-src-');
    write(sourceRoot, '.claude/agents/scribe.md', AGENT_TEXT);
    write(sourceRoot, '.claude/skills/same/SKILL.md', 'identical');
    write(sourceRoot, '.claude/skills/parked/SKILL.md', 'parked v2');
    write(workspace, '.claude/skills/same/SKILL.md', 'identical'); // already at the approved bytes
    write(workspace, '.claude/skills/parked/SKILL.md', 'parked');
    config.setWorkspace(workspace);
    const approval = decide(planVia(sourceRoot), {
      'agent:scribe': 'add', 'skill:same': 'overwrite', 'skill:parked': 'skip',
    });
    const reply = dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval });
    assert.strictEqual(reply.status, 'ready');
    const receipt = JSON.parse(fs.readFileSync(path.join(workspace, reply.receipt), 'utf8'));
    // Each entry also records the decision that governed it, so a later
    // import can say what was decided last time rather than guessing.
    const decisionOf = Object.fromEntries(approval.items.map((i) => [i.id, i.decision]));
    const entry = (outcome) => (o) => ({ id: o.id, kind: o.kind, destination: o.destination, decision: decisionOf[o.id], outcome });
    // An entry that is in the workspace afterwards also records the digest of
    // its bytes as written, which for a verified apply is the approved digest.
    const approvedOf = Object.fromEntries(approval.items.map((i) => [i.id, i.approvedDigest]));
    // And the authored digest an update compares: for an agent its bytes
    // with Rundock's own routine fields left out, for a skill the same digest.
    const authoredOf = (o) => (o.kind === 'agent'
      ? authoredDigest('agent', fs.readFileSync(path.join(workspace, o.destination))) : approvedOf[o.id]);
    const landed = (outcome) => (o) => ({ ...entry(outcome)(o), fingerprint: approvedOf[o.id], authored: authoredOf(o) });
    const expected = [
      ...reply.writes.map(landed('written')),
      ...reply.unchanged.map(landed('unchanged')),
      ...reply.skipped.map(entry('skipped')),
      ...reply.blocked.map(entry('blocked')),
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    assert.deepStrictEqual(receipt.items, expected);
    assert.deepStrictEqual(receipt.items.map((i) => [i.id, i.outcome]),
      [['agent:scribe', 'written'], ['skill:parked', 'skipped'], ['skill:same', 'unchanged']]);
  });

  test('blocked outcomes appear in the receipt when a ready apply carries them', () => {
    const workspace = makeTempDir('proto-ws-');
    const sourceRoot = makeTempDir('proto-src-');
    write(sourceRoot, '.claude/agents/alpha.md', '---\norder: 0\n---\n\nA.\n');
    write(sourceRoot, '.claude/agents/beta.md', '---\norder: 0\n---\n\nB.\n');
    write(sourceRoot, '.claude/skills/writer/SKILL.md', 'skill');
    config.setWorkspace(workspace);
    const approval = decide(planVia(sourceRoot), {
      'agent:alpha': 'add', 'agent:beta': 'add', 'skill:writer': 'add',
    });
    const reply = dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval });
    assert.strictEqual(reply.status, 'ready');
    const receipt = JSON.parse(fs.readFileSync(path.join(workspace, reply.receipt), 'utf8'));
    assert.deepStrictEqual(receipt.items.map((i) => [i.id, i.outcome]),
      [['agent:alpha', 'blocked'], ['agent:beta', 'blocked'], ['skill:writer', 'written']]);
  });

  test('a stale destination replies with zero writes, reasons and an untouched tree', () => {
    const { workspace, sourceRoot } = fixture();
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    write(workspace, '.claude/skills/writer/SKILL.md', 'changed after approval');
    const before = tree(workspace);
    const reply = dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval });
    assert.strictEqual(reply.status, 'stale');
    assert.deepStrictEqual(reply.written, []);
    assert.strictEqual(reply.receipt, null);
    assert.deepStrictEqual(reply.stale.map((s) => [s.id, s.reason]), [['skill:writer', 'destination-changed']]);
    assert.deepStrictEqual(tree(workspace), before);
  });

  test('a decisions-blocked evaluation replies with zero writes and no receipt', () => {
    const workspace = makeTempDir('proto-ws-');
    const sourceRoot = makeTempDir('proto-src-');
    write(sourceRoot, '.claude/agents/alpha.md', '---\norder: 0\n---\n\nA.\n');
    write(sourceRoot, '.claude/agents/beta.md', '---\norder: 0\n---\n\nB.\n');
    config.setWorkspace(workspace);
    const approval = decide(planVia(sourceRoot), { 'agent:alpha': 'add', 'agent:beta': 'add' });
    const before = tree(workspace);
    const reply = dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval });
    assert.strictEqual(reply.status, 'decisions-blocked');
    assert.deepStrictEqual(reply.written, []);
    assert.strictEqual(reply.receipt, null);
    assert.deepStrictEqual(tree(workspace), before);
  });

  test('an evaluator validation error surfaces as a structured error with an untouched tree', () => {
    const { workspace, sourceRoot } = fixture();
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    approval.schema = 'rundock.package-import-approval/v0';
    const before = tree(workspace);
    const reply = dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval });
    assert.strictEqual(reply.type, 'package_import_error');
    assert.strictEqual(reply.operation, 'apply');
    assert.match(reply.message, /approval\.schema/);
    assert.deepStrictEqual(tree(workspace), before);
  });

  test('a byte-verification refusal surfaces as a structured error with zero writes and no receipt', () => {
    const { workspace, sourceRoot } = fixture();
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    approval.items.find((i) => i.id === 'agent:scribe').approvedDigest = digestFile(Buffer.from('other bytes'));
    const before = tree(workspace);
    const reply = dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval });
    assert.strictEqual(reply.type, 'package_import_error');
    assert.strictEqual(reply.operation, 'apply');
    assert.match(reply.message, /do not match the approved digest/);
    assert.deepStrictEqual(tree(workspace), before);
    assert.strictEqual(fs.existsSync(path.join(workspace, RECEIPTS)), false);
  });

  test('a journal failure surfaces as a structured error with zero writes and no receipt', () => {
    const { workspace, sourceRoot } = fixture();
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    fs.mkdirSync(path.dirname(journalPath(workspace)), { recursive: true });
    fs.writeFileSync(journalPath(workspace), 'not json');
    const before = tree(workspace);
    const reply = dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval });
    assert.strictEqual(reply.type, 'package_import_error');
    assert.strictEqual(reply.operation, 'apply');
    assert.match(reply.message, /cannot be trusted/);
    assert.deepStrictEqual(tree(workspace), before);
    assert.strictEqual(fs.existsSync(path.join(workspace, RECEIPTS)), false);
  });

  test('a source item added after planning appears nowhere and is never written', () => {
    const { workspace, sourceRoot } = fixture();
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    write(sourceRoot, '.claude/skills/uninvited/SKILL.md', 'not approved');
    const reply = dispatchJson('apply_package_import', { sourcePath: sourceRoot, approval });
    assert.strictEqual(reply.status, 'ready');
    const ids = ['writes', 'unchanged', 'skipped', 'blocked', 'stale'].flatMap((k) => reply[k].map((o) => o.id));
    assert.strictEqual(ids.includes('skill:uninvited'), false);
    assert.strictEqual(fs.existsSync(path.join(workspace, '.claude/skills/uninvited')), false);
  });
});

// A confirmed update moves the package to its new release even when no item
// is written: the receipt is what names the installed release, so an update
// that left none would keep offering itself. A replayed install, which names
// no release, still writes nothing (the replay test above holds that).
describe('a confirmed update always leaves a receipt naming the new release', () => {
  const original = config.getWorkspace();
  test.after(() => config.setWorkspace(original));
  const { applyImport } = require('../../lib/packages/import-apply.js');
  const UPDATE = { from: 'v1.0.0', to: 'v2.0.0' };

  function installed() {
    const { workspace, sourceRoot } = fixture();
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    applyImport(workspace, sourceRoot, approval, { receipt: { now: '2026-09-24T09:00:00.000Z', run: 'install' } });
    return { workspace, sourceRoot, approval };
  }

  test('an update where every item already matches writes a receipt naming the new release', () => {
    const { workspace, sourceRoot, approval } = installed();
    const result = applyImport(workspace, sourceRoot, approval, {
      receipt: { now: '2026-09-25T09:00:00.000Z', run: 'same', update: UPDATE },
    });
    assert.strictEqual(result.status, 'ready');
    assert.deepStrictEqual(result.writes, []);
    assert.strictEqual(result.receipt, `${RECEIPTS}/2026-09-25-same.json`);
    const receipt = JSON.parse(fs.readFileSync(path.join(workspace, result.receipt), 'utf8'));
    assert.deepStrictEqual(receipt.update, UPDATE);
    assert.deepStrictEqual(receipt.items.map((i) => [i.id, i.outcome]),
      [['agent:scribe', 'unchanged'], ['skill:writer', 'unchanged']]);
  });

  test('an update whose only change is items leaving writes a receipt naming the new release', () => {
    const { workspace, sourceRoot, approval } = installed();
    const retired = [{ id: 'skill:old', kind: 'skill', destination: '.claude/skills/old' }];
    const result = applyImport(workspace, sourceRoot, approval, {
      receipt: { now: '2026-09-25T09:00:00.000Z', run: 'leaving', update: { ...UPDATE, retired } },
    });
    assert.strictEqual(result.status, 'ready');
    assert.deepStrictEqual(result.writes, []);
    assert.ok(result.receipt, 'the update is recorded although nothing reached a destination');
    const receipt = JSON.parse(fs.readFileSync(path.join(workspace, result.receipt), 'utf8'));
    assert.deepStrictEqual(receipt.update, UPDATE);
    assert.deepStrictEqual(receipt.items.find((i) => i.id === 'skill:old'),
      { id: 'skill:old', kind: 'skill', destination: '.claude/skills/old', outcome: 'kept', inPackage: false });
  });

  test('an unnamed update is a replay and still writes nothing', () => {
    const { workspace, sourceRoot, approval } = installed();
    const after = tree(workspace);
    const result = applyImport(workspace, sourceRoot, approval, { receipt: { update: { from: 'v1.0.0' } } });
    assert.strictEqual(result.receipt, null);
    assert.deepStrictEqual(tree(workspace), after);
  });
});

describe('the receipt seam is what the file is built from', () => {
  const original = config.getWorkspace();
  test.after(() => config.setWorkspace(original));

  test('an injected clock and run suffix name the receipt, and its body carries them', () => {
    const { workspace, sourceRoot } = fixture();
    const { applyImport } = require('../../lib/packages/import-apply.js');
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    // A clock whose local and UTC dates differ in most timezones: the date
    // component must be the UTC one, which slicing the ISO string guarantees.
    const now = '2026-01-02T23:30:00.000Z';
    const result = applyImport(workspace, sourceRoot, approval, { receipt: { now, run: 'fixedrun' } });
    const expected = `${RECEIPTS}/2026-01-02-fixedrun.json`;
    assert.strictEqual(result.receipt, expected);
    const receipt = JSON.parse(fs.readFileSync(path.join(workspace, expected), 'utf8'));
    assert.strictEqual(receipt.schema, 'rundock.package-import-receipt/v1');
    assert.strictEqual(receipt.appliedAt, now);
  });
});

describe('the receipt lives and dies with the transaction', () => {
  const original = config.getWorkspace();
  test.after(() => config.setWorkspace(original));

  const boundaries = (() => {
    const { workspace, sourceRoot } = fixture();
    const { applyImport } = require('../../lib/packages/import-apply.js');
    const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
    const steps = [];
    applyImport(workspace, sourceRoot, approval, {
      receipt: {},
      afterStep: (s) => steps.push(`${s.phase}:${s.action}`),
    });
    return steps;
  })();

  for (let boundary = 1; boundary <= boundaries.length; boundary++) {
    test(`a fault after ${boundaries[boundary - 1]} (step ${boundary} of ${boundaries.length}) leaves no receipt and the pre-apply tree`, () => {
      const { workspace, sourceRoot } = fixture();
      const { applyImport } = require('../../lib/packages/import-apply.js');
      const approval = decide(planVia(sourceRoot), { 'agent:scribe': 'add', 'skill:writer': 'overwrite' });
      const before = tree(workspace);
      let completed = 0;
      assert.throws(() => applyImport(workspace, sourceRoot, approval, {
        receipt: {},
        afterStep: () => {
          completed += 1;
          if (completed === boundary) throw new Error('injected fault');
        },
      }), /injected fault/);
      assert.deepStrictEqual(tree(workspace), before);
      assert.strictEqual(fs.existsSync(path.join(workspace, RECEIPTS)), false);
    });
  }
});
