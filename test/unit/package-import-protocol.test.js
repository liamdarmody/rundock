'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const { decide, buildPlan } = require('../../lib/packages/import-plan.js');
const { journalPath } = require('../../lib/workspace/atomic-write.js');
const { digestFile } = require('../../lib/packages/import-apply.js');
const config = require('../../lib/config.js');
const { makeTempDir } = require('../helpers/workspace.js');

const SOURCE = { id: 'github.com/example/pack', reference: 'v1.0.0' };
const RECEIPTS = '.claude/rundock/receipts';

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
// would send it, and every reply is read back from the wire capture.
function dispatchJson(type, payload) {
  const dispatch = buildDispatch();
  const ws = captureWs();
  dispatch[type]({}, ws, JSON.parse(JSON.stringify({ type, ...payload })));
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
    ['a non-canonical skill name', (root) => write(root, '.claude/skills/Bad Name/SKILL.md', 'x'), /not a canonical skill name/],
    ['a non-canonical agent name', (root) => write(root, '.claude/agents/Not A Slug.md', AGENT_TEXT), /not a canonical agent file name/],
    ['a symlink in the source', (root) => {
      write(root, 'real.md', AGENT_TEXT);
      fs.symlinkSync(path.join(root, 'real.md'), path.join(root, '.claude/agents/link.md'));
    }, /is a symlink/],
    ['unterminated agent frontmatter', (root) => write(root, '.claude/agents/broken.md', '---\nname: broken\n'), /never closes/],
  ];

  for (const [name, build, message] of PLAN_REFUSALS) {
    test(`${name} surfaces as a structured plan error with the workspace unchanged`, () => {
      const { workspace, sourceRoot } = fixture();
      build(sourceRoot);
      const before = tree(workspace);
      const reply = dispatchJson('plan_package_import', { sourcePath: sourceRoot, source: SOURCE });
      assert.strictEqual(reply.type, 'package_import_error');
      assert.strictEqual(reply.operation, 'plan');
      assert.match(reply.message, message);
      assert.doesNotMatch(reply.message, /\n\s+at /); // a message, not a stack trace
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
    const expected = [
      ...reply.writes.map((o) => ({ id: o.id, kind: o.kind, destination: o.destination, outcome: 'written' })),
      ...reply.unchanged.map((o) => ({ id: o.id, kind: o.kind, destination: o.destination, outcome: 'unchanged' })),
      ...reply.skipped.map((o) => ({ id: o.id, kind: o.kind, destination: o.destination, outcome: 'skipped' })),
      ...reply.blocked.map((o) => ({ id: o.id, kind: o.kind, destination: o.destination, outcome: 'blocked' })),
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
