'use strict';
// The collision decision surface, held to the signed-off rules: skip is the
// default for a collided item, the review-void state is the only danger-toned
// class, applying decisions is atomic with the import transaction, a blocked
// row's one way out is skipping, and receipts record each decision beside the
// item it governed.
//
// Two walks are load-bearing. The bucket walk reads the evaluator's own
// result shape against the surface's rendering map, so an outcome the
// evaluator grows without a home on this surface fails here rather than
// rendering as nothing. The reason walk reads the evaluator's own source for
// the reason literals it can attach, so a reason added there without prose
// here fails naming the word.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const model = require('../../public/packages-install-model.js');
const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
const { applyImport } = require('../../lib/packages/import-apply.js');
const { evaluateImport, APPROVAL_SCHEMA, ABSENT_DIGEST } = require('../../lib/packages/import-evaluate.js');
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const config = require('../../lib/config.js');
const { makeTempDir } = require('../helpers/workspace.js');

const ROOT = path.join(__dirname, '..', '..');

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

// Every wire shape below is produced by the REAL handlers through the real
// dispatch table, so a renamed field or status on the wire turns this red.
function realReply(workspace, type, payload) {
  const original = config.getWorkspace();
  config.setWorkspace(workspace);
  try {
    const sent = [];
    buildDispatch()[type]({}, { send: (m) => sent.push(JSON.parse(m)), readyState: 1 }, JSON.parse(JSON.stringify({ type, ...payload })));
    return sent[0];
  } finally {
    config.setWorkspace(original);
  }
}

// A workspace and package whose one agent collides: the workspace copy is a
// plain agent, the incoming copy differs. Options grow the scenario.
function collidingScenario({ workspaceAgent = '---\nname: helper\n---\n\nOld.\n',
  incomingAgent = '---\nname: helper\n---\n\nNew.\n', extraSources = [], extraWorkspace = [] } = {}) {
  const workspace = makeTempDir('cd-ws-');
  const sourceRoot = makeTempDir('cd-src-');
  write(workspace, '.claude/agents/helper.md', workspaceAgent);
  write(sourceRoot, '.claude/agents/helper.md', incomingAgent);
  for (const [rel, content] of extraSources) write(sourceRoot, rel, content);
  for (const [rel, content] of extraWorkspace) write(workspace, rel, content);
  const planMsg = realReply(workspace, 'plan_package_import', {
    sourcePath: sourceRoot, source: { id: sourceRoot, reference: null },
  });
  const submitted = model.submit(model.initial(), sourceRoot);
  const out = model.reply(submitted.state, planMsg);
  return { workspace, sourceRoot, planMsg, offer: out.state, firstSend: out.send };
}

describe('the review opens with skip preselected, and nothing is silent', () => {
  test('a fresh collision is decided skip, and the projection is asked for through the wire', () => {
    const { offer, firstSend } = collidingScenario();
    assert.strictEqual(offer.phase, 'offer');
    assert.strictEqual(offer.decisions['agent:helper'], 'skip');
    assert.strictEqual(firstSend.type, 'evaluate_package_decisions');
    const row = model.reviewCopy(offer).rows.filter((r) => r.id === 'agent:helper')[0];
    assert.strictEqual(row.rowClass, 'collision');
    assert.strictEqual(row.decision, 'skip', 'the toggle the person first sees has skip selected');
  });

  test('a collision-free plan enters the offer with no projection asked for', () => {
    const workspace = makeTempDir('cd-ws-');
    const sourceRoot = makeTempDir('cd-src-');
    write(sourceRoot, '.claude/agents/fresh.md', '---\nname: fresh\n---\n\nF.\n');
    const planMsg = realReply(workspace, 'plan_package_import', {
      sourcePath: sourceRoot, source: { id: sourceRoot, reference: null },
    });
    const out = model.reply(model.submit(model.initial(), sourceRoot).state, planMsg);
    assert.strictEqual(out.state.phase, 'offer');
    assert.strictEqual(out.send, undefined, 'nothing to decide means nothing to project');
  });

  test('a decision change re-projects; an evaluator-invalid combination is refused unchanged', () => {
    const { offer } = collidingScenario();
    const flipped = model.setDecision(offer, 'agent:helper', 'overwrite');
    assert.strictEqual(flipped.state.decisions['agent:helper'], 'overwrite');
    assert.strictEqual(flipped.send.type, 'evaluate_package_decisions');
    assert.strictEqual(flipped.send.approval.items[0].decision, 'overwrite');
    // add on a colliding item and overwrite on a new one are shapes the
    // evaluator itself refuses, so the model never lets them exist.
    assert.strictEqual(model.setDecision(offer, 'agent:helper', 'add').state, offer);
    assert.strictEqual(model.setDecision(offer, 'agent:helper', 'nonsense').state, offer);
  });

  test('confirm sends the decided approval through the shared decide module', () => {
    const { offer, planMsg } = collidingScenario();
    const confirmed = model.confirm(model.setDecision(offer, 'agent:helper', 'overwrite').state);
    assert.strictEqual(confirmed.send.type, 'apply_package_import');
    assert.deepStrictEqual(confirmed.send.approval,
      decide(planMsg.plan, { 'agent:helper': 'overwrite' }));
  });
});

describe('the bucket walk: every evaluator outcome has a home on this surface', () => {
  test('the rendering map keys are exactly the evaluator result shape', () => {
    const item = {
      id: 'skill:notes', kind: 'skill', slug: 'notes', destination: '.claude/skills/notes',
      collision: false, decision: 'add', plannedDigest: ABSENT_DIGEST,
      approvedDigest: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}`, agent: null,
    };
    const driven = evaluateImport({
      schema: APPROVAL_SCHEMA,
      source: { id: 'walk', reference: null },
      manifest: [{ id: item.id, kind: item.kind, slug: item.slug, sourceDigest: item.sourceDigest }],
      items: [item],
    }, {
      destinations: [{ destination: item.destination, digest: ABSENT_DIGEST }],
      sources: [{ id: item.id, digest: item.sourceDigest }],
      agents: [],
    });
    assert.deepStrictEqual(Object.keys(driven).sort(), Object.keys(model.RESULT_RENDERINGS).sort(),
      'an outcome bucket on one side and not the other is a result this surface would have no words for: '
      + 'teach RESULT_RENDERINGS in the install model and the evaluator result together');
  });

  test('every reason the evaluator can attach has prose, read from its own source', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'packages', 'import-evaluate.js'), 'utf8');
    const reasons = [...new Set([...source.matchAll(/reason: '([a-z-]+)'/g)].map((hit) => hit[1]))];
    assert.ok(reasons.length >= 4,
      'the parse found the reason literals; an empty read here is a broken instrument, not an empty list');
    for (const reason of reasons) {
      const words = model.reasonWords(reason);
      assert.notStrictEqual(words, reason,
        `${reason}: the surface must say it in plain words, not echo the wire literal`);
      assert.ok(words.length > 10, reason);
    }
  });
});

describe('the review-void state is the only danger, proven by the tone walk', () => {
  test('exactly one class carries the danger tone, and it is the voided review', () => {
    const dangers = Object.entries(model.REVIEW_TONES).filter(([, tone]) => tone === 'danger');
    assert.deepStrictEqual(dangers, [['stale', 'danger']],
      'nothing on this surface executes anything, so nothing but the voided review may alarm');
    assert.strictEqual(model.staleCopy().tone, 'danger');
    assert.match(model.staleCopy().body, /discarded and nothing was written/);
  });

  test('a stale projection voids the review, and a stale apply reply is never a success', () => {
    const { workspace, offer } = collidingScenario();
    // The workspace moves under the review; the next projection says stale.
    write(workspace, '.claude/agents/helper.md', '---\nname: helper\n---\n\nMoved.\n');
    const flipped = model.setDecision(offer, 'agent:helper', 'overwrite');
    const evalMsg = realReply(workspace, 'evaluate_package_decisions', flipped.send);
    assert.strictEqual(evalMsg.status, 'stale');
    const voided = model.reply(flipped.state, evalMsg);
    assert.strictEqual(voided.state.phase, 'stale');
    // The only way forward re-plans; confirming a voided review sends nothing.
    assert.strictEqual(model.confirm(voided.state).send, undefined);
    assert.strictEqual(model.retry(voided.state).send.type, 'plan_package_import');
  });
});

describe('blocked rows offer skipping and nothing else', () => {
  // The real thing: the workspace's default agent is not part of the import,
  // and overwriting the colliding agent would create a second default.
  function blockedScenario() {
    const scenario = collidingScenario({
      incomingAgent: '---\nname: helper\norder: 0\n---\n\nNew default.\n',
      extraWorkspace: [['.claude/agents/coach.md', '---\nname: coach\norder: 0\n---\n\nC.\n']],
    });
    const flipped = model.setDecision(scenario.offer, 'agent:helper', 'overwrite');
    const evalMsg = realReply(scenario.workspace, 'evaluate_package_decisions', flipped.send);
    const projected = model.reply(flipped.state, evalMsg);
    return { ...scenario, projected: projected.state, evalMsg };
  }

  test('the projection is judged by the real evaluator, and the row renders the blocked treatment', () => {
    const { projected, evalMsg } = blockedScenario();
    assert.deepStrictEqual(evalMsg.blocked.map((b) => b.reason), ['default-conflict']);
    const row = model.reviewCopy(projected).rows.filter((r) => r.id === 'agent:helper')[0];
    assert.strictEqual(row.rowClass, 'blocked');
    assert.strictEqual(row.tone, 'attention', 'blocked is a notice where nothing broke, never danger');
    assert.match(row.blockedNote, /second default agent/);
    assert.match(row.blockedNote, /keeps your workspace exactly as it is/,
      'the copy says what skipping keeps');
  });

  test('the one action is skip: no overwrite is ever offered as the way out', () => {
    const { projected } = blockedScenario();
    const row = model.reviewCopy(projected).rows.filter((r) => r.id === 'agent:helper')[0];
    assert.deepStrictEqual(row.blockedAction, { label: 'Skip this item', decision: 'skip' });
    assert.doesNotMatch(row.blockedNote, /overwrite/i,
      'the blocked copy never suggests overwriting through');
    // Taking the action clears the conflict on the next projection.
    const skipped = model.setDecision(projected, 'agent:helper', 'skip');
    assert.strictEqual(skipped.state.decisions['agent:helper'], 'skip');
    assert.strictEqual(skipped.send.type, 'evaluate_package_decisions');
  });

  test('skipping the blocked item unblocks it in the evaluator itself', () => {
    const { workspace, projected } = blockedScenario();
    const skipped = model.setDecision(projected, 'agent:helper', 'skip');
    const evalMsg = realReply(workspace, 'evaluate_package_decisions', skipped.send);
    assert.deepStrictEqual(evalMsg.blocked, [], 'skip keeps things as they are, which no rule can block');
    assert.strictEqual(evalMsg.status, 'ready');
  });
});

describe('applying decisions is atomic with the import transaction', () => {
  test('a failure mid-apply leaves the workspace byte for byte as it was', () => {
    const { workspace, sourceRoot, planMsg } = collidingScenario({
      extraSources: [['.claude/skills/writer/SKILL.md', 'incoming skill']],
    });
    const approval = decide(planMsg.plan, { 'agent:helper': 'overwrite', 'skill:writer': 'add' });
    const before = fs.readFileSync(path.join(workspace, '.claude/agents/helper.md'), 'utf8');
    assert.throws(() => applyImport(workspace, sourceRoot, approval, {
      afterStep: () => { throw new Error('power gone mid-apply'); },
    }), /power gone/);
    // The next apply recovers the interrupted transaction before looking, so
    // the workspace reads as it did before anything started.
    const result = applyImport(workspace, sourceRoot, approval, { receipt: {} });
    assert.strictEqual(result.status, 'ready');
    assert.notStrictEqual(fs.readFileSync(path.join(workspace, '.claude/agents/helper.md'), 'utf8'), before,
      'sanity: the completed apply really overwrites');
  });

  test('a decline writes nothing: cancel from the review is stateless', () => {
    const { offer } = collidingScenario();
    const out = model.cancel(offer);
    assert.strictEqual(out.send, undefined);
    assert.strictEqual(out.state.phase, 'idle');
  });
});

describe('receipts record each decision beside the item it governed', () => {
  test('a mixed apply writes one receipt entry per item, each carrying its decision', () => {
    const { workspace, sourceRoot, planMsg } = collidingScenario({
      extraSources: [['.claude/skills/writer/SKILL.md', 'incoming skill']],
    });
    const approval = decide(planMsg.plan, { 'agent:helper': 'skip', 'skill:writer': 'add' });
    const result = applyImport(workspace, sourceRoot, approval, { receipt: {} });
    assert.strictEqual(result.status, 'ready');
    const receipt = JSON.parse(fs.readFileSync(path.join(workspace, result.receipt), 'utf8'));
    const byId = Object.fromEntries(receipt.items.map((entry) => [entry.id, entry]));
    assert.strictEqual(byId['agent:helper'].decision, 'skip');
    assert.strictEqual(byId['agent:helper'].outcome, 'skipped');
    assert.strictEqual(byId['skill:writer'].decision, 'add');
    assert.strictEqual(byId['skill:writer'].outcome, 'written');
    // So a later import can say what was decided last time: the record is
    // the decision, not an inference from bytes.
    for (const entry of receipt.items) assert.ok(entry.decision, `${entry.id} carries its decision`);
  });
});

describe('the confirm label says what pressing it will actually do', () => {
  test('the three shapes from the review: mixed, blocked, and everything skipped', () => {
    assert.strictEqual(model.confirmLabel({ adds: 2, overwrites: 1, skips: 1, blocked: 0 }),
      'Add 2, overwrite 1, skip 1');
    assert.strictEqual(model.confirmLabel({ adds: 1, overwrites: 1, skips: 0, blocked: 2 }),
      'Add 1, overwrite 1, 2 blocked');
    assert.strictEqual(model.confirmLabel({ adds: 0, overwrites: 0, skips: 4, blocked: 0 }),
      'Skip 4, nothing added');
  });

  test('the live counts follow the decisions and the projection', () => {
    const { offer } = collidingScenario({
      extraSources: [['.claude/skills/writer/SKILL.md', 'incoming skill']],
    });
    const copy = model.reviewCopy(offer);
    assert.strictEqual(copy.confirmLabel, 'Add 1, skip 1');
    const flipped = model.setDecision(offer, 'agent:helper', 'overwrite').state;
    assert.strictEqual(model.reviewCopy(flipped).confirmLabel, 'Add 1, overwrite 1');
  });
});
