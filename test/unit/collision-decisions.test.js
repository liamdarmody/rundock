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

// A transition's own outstanding projection, answered by the real evaluator
// through the real dispatch, and landed on the state that asked for it.
function projected(workspace, out) {
  return model.reply(out.state, realReply(workspace, 'evaluate_package_decisions', out.send)).state;
}

// The complete tree under a root as one comparable value: every path and
// every byte, directories included so an orphaned empty one is visible too.
// Used to prove a mid-apply failure leaves the workspace exactly as it was,
// which a single file's bytes cannot: a stray journal or receipts directory
// under a path the test never names would pass a narrower check.
function workspaceTree(root) {
  const result = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        const before = result.length;
        walk(absolute);
        if (result.length === before) result.push(`${relative}/`);
      } else {
        result.push(`${relative}:${fs.readFileSync(absolute).toString('base64')}`);
      }
    }
  };
  walk(root);
  return result;
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

describe('a reply is matched to the request that produced it, not to the phase it lands in', () => {
  test('an evaluate reply delivered after Confirm leaves the flow in applying until the real apply result arrives', () => {
    const { workspace, offer } = collidingScenario();
    // A decision changes, asking a fresh projection, and Confirm is pressed
    // before that projection's reply lands: the flow moves to 'applying'
    // with an evaluate reply still outstanding.
    const flipped = model.setDecision(offer, 'agent:helper', 'overwrite');
    const confirmed = model.confirm(flipped.state);
    assert.strictEqual(confirmed.state.phase, 'applying');

    // The stale evaluate reply arrives first. It carries the same operation
    // and envelope shape an apply reply does, but not this apply's own
    // requestId, so it must change nothing.
    const staleEvalReply = realReply(workspace, 'evaluate_package_decisions', flipped.send);
    assert.strictEqual(staleEvalReply.operation, 'evaluate');
    const afterStale = model.reply(confirmed.state, staleEvalReply);
    assert.strictEqual(afterStale.state, confirmed.state, 'the stale projection is ignored outright, by identity');
    assert.strictEqual(afterStale.state.phase, 'applying');

    // The real apply reply, matched by its own requestId, is the one that
    // actually lands the flow.
    const applyReplyMsg = realReply(workspace, 'apply_package_import', confirmed.send);
    assert.strictEqual(applyReplyMsg.operation, 'apply');
    const done = model.reply(afterStale.state, applyReplyMsg);
    assert.strictEqual(done.state.phase, 'done');
    assert.strictEqual(done.state.written.length, 1);
  });

  test('an evaluate reply delivered after a cancel-and-resubmit leaves the flow classifying rather than throwing', () => {
    const { workspace, sourceRoot, offer, firstSend } = collidingScenario();
    // Cancel discards the review; resubmitting re-enters 'classifying' while
    // the FIRST review's evaluate request is still out on the wire.
    const cancelled = model.cancel(offer);
    const resubmitted = model.submit(cancelled.state, sourceRoot);
    assert.strictEqual(resubmitted.state.phase, 'classifying');

    const staleEvalReply = realReply(workspace, 'evaluate_package_decisions', firstSend);
    const result = model.reply(resubmitted.state, staleEvalReply);
    assert.strictEqual(result.state, resubmitted.state,
      'the stray projection changes nothing; planReply must refuse a result message rather than read msg.plan.items');
    assert.strictEqual(result.state.phase, 'classifying');
  });

  test('a superseded evaluate reply changes nothing once a newer decision has asked its own projection', () => {
    const { workspace, offer } = collidingScenario();
    // Two decisions in a row: the first ask is still outstanding when the
    // second is made, superseding it. Nothing here guarantees delivery
    // order on the wire, so the older reply is delivered LAST, after the
    // newer one has already landed, which is the harder direction to get
    // right.
    const first = model.setDecision(offer, 'agent:helper', 'overwrite');
    const second = model.setDecision(first.state, 'agent:helper', 'skip');
    assert.notStrictEqual(first.send.requestId, second.send.requestId);

    const secondReply = realReply(workspace, 'evaluate_package_decisions', second.send);
    const afterSecond = model.reply(second.state, secondReply);
    assert.ok(afterSecond.state.projection, 'the current request\'s own answer is applied');

    const firstReply = realReply(workspace, 'evaluate_package_decisions', first.send);
    const afterFirst = model.reply(afterSecond.state, firstReply);
    assert.strictEqual(afterFirst.state, afterSecond.state,
      'a reply to a decision this review has since moved past must not overwrite the current projection');
  });

  test('a real evaluate refusal renders the failed state with a re-plan path, matched by the outstanding request', () => {
    const { workspace, offer } = collidingScenario();
    // Malformed enough to hit the handler's catch (no sourcePath), but
    // carrying the offer's own outstanding evaluateRequestId, so this is
    // read as the answer to the request the offer is actually waiting on
    // rather than dropped as foreign.
    const refusal = realReply(workspace, 'evaluate_package_decisions',
      { requestId: offer.evaluateRequestId, approval: {} });
    assert.strictEqual(refusal.type, 'package_import_error');
    assert.strictEqual(refusal.operation, 'evaluate');
    assert.match(refusal.message, /sourcePath is required/);
    const failed = model.reply(offer, refusal);
    assert.strictEqual(failed.state.phase, 'failed');
    assert.strictEqual(failed.state.canReplan, true);
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

  test('the evaluator can only ever attach default-conflict to a blocked item, pinned against its own source', () => {
    // Isolated to the blocked array's own construction, not the whole file:
    // the reason walk above already covers every reason literal that exists
    // anywhere in this source, including the ones stale outcomes carry, so
    // this reads only the slice that builds `blocked` and holds it to one
    // literal. A second blocking reason added there fails this assertion,
    // naming itself, rather than reviewCopy's blockedNote silently keeping
    // the default-conflict sentence for a cause it no longer names.
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'packages', 'import-evaluate.js'), 'utf8');
    const blockedBuild = source.slice(source.indexOf('const blocked ='), source.indexOf('const writes ='));
    assert.ok(blockedBuild.length > 20, 'the parse found the blocked-array construction; an empty read is a broken instrument');
    const reasons = [...new Set([...blockedBuild.matchAll(/reason: '([a-z-]+)'/g)].map((hit) => hit[1]))];
    assert.deepStrictEqual(reasons, ['default-conflict']);
  });

  test('the blocked row\'s copy is the projection\'s own reason, said through reasonWords, not a second hard-coded copy', () => {
    const { projected } = (() => {
      const scenario = collidingScenario({
        incomingAgent: '---\nname: helper\norder: 0\n---\n\nNew default.\n',
        extraWorkspace: [['.claude/agents/coach.md', '---\nname: coach\norder: 0\n---\n\nC.\n']],
      });
      const flipped = model.setDecision(scenario.offer, 'agent:helper', 'overwrite');
      const evalMsg = realReply(scenario.workspace, 'evaluate_package_decisions', flipped.send);
      return { projected: model.reply(flipped.state, evalMsg).state };
    })();
    const row = model.reviewCopy(projected).rows.filter((r) => r.id === 'agent:helper')[0];
    assert.strictEqual(row.blockedNote, `Blocked: ${model.reasonWords('default-conflict')}. `
      + 'Skipping this item keeps your workspace exactly as it is and clears the conflict.');
  });
});

describe('the class walk: every rowClass reviewRowClass can produce is rendered, not merely named', () => {
  // The classes are read from the surface's own source, the same technique
  // the reason walk uses: a class reviewRowClass can return without a
  // scenario here that exercises it fails this assertion by name, instead of
  // the walk quietly trusting whatever set of tests happens to exist today.
  test('the literals reviewRowClass can return match what this file exercises', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public', 'packages-install-model.js'), 'utf8');
    const body = source.slice(source.indexOf('function reviewRowClass('), source.indexOf('function reviewCounts('));
    // Only the strings the function actually RETURNS: directly after
    // `return`, or as one branch of the trailing ternary (after `?` or `:`).
    // 'skip', compared against but never returned, must not count as a class.
    const classes = [...new Set([...body.matchAll(/(?:return\s+|\?\s*|:\s*)'([a-zA-Z]+)'/g)].map((hit) => hit[1]))].sort();
    assert.deepStrictEqual(classes, ['blocked', 'collision', 'skippedNew', 'willAdd'],
      'reviewRowClass can return a class this walk does not know to exercise; teach this walk the new one');
  });

  test('willAdd and collision both render through one real plan, side by side', () => {
    // extraSources adds a second, non-colliding item to the same collision
    // scenario every other describe block already uses, so the willAdd row
    // is produced by the real plan handler rather than a hand-built state.
    const { offer } = collidingScenario({
      extraSources: [['.claude/skills/writer/SKILL.md', 'incoming skill']],
    });
    const copy = model.reviewCopy(offer);
    const willAddRow = copy.rows.filter((r) => r.id === 'skill:writer')[0];
    assert.strictEqual(willAddRow.rowClass, 'willAdd');
    assert.strictEqual(willAddRow.tone, 'success');
    assert.strictEqual(willAddRow.compare, null);
    const collisionRow = copy.rows.filter((r) => r.id === 'agent:helper')[0];
    assert.strictEqual(collisionRow.rowClass, 'collision');
    assert.strictEqual(collisionRow.tone, 'neutral');
    assert.ok(collisionRow.compare, 'a collision carries the have/arrives compare');
  });

  test('skippedNew: a new item explicitly skipped renders the row that offers to add it back', () => {
    const { offer } = collidingScenario({
      extraSources: [['.claude/skills/writer/SKILL.md', 'incoming skill']],
    });
    const skipped = model.setDecision(offer, 'skill:writer', 'skip');
    assert.strictEqual(skipped.send.type, 'evaluate_package_decisions');
    const row = model.reviewCopy(skipped.state).rows.filter((r) => r.id === 'skill:writer')[0];
    assert.strictEqual(row.rowClass, 'skippedNew');
    assert.strictEqual(row.tone, 'neutral');
    assert.strictEqual(row.compare, null);
  });

  // 'blocked' is exercised end to end by the describe block above (a real
  // evaluator refusal driving reviewCopy's blockedNote and blockedAction),
  // against a real default-conflict rather than a hand-built projection.

  test('a byte-identical collision renders the compare copy that says so, judged by the real digests', () => {
    // Skills are used here rather than agents: materialise() rewrites an
    // agent with a provenance line, so an agent's approvedDigest can never
    // equal a bare workspace copy's plannedDigest, and this branch could
    // never be reached with the agent-based scenario every other test uses.
    const workspace = makeTempDir('cd-ws-');
    const sourceRoot = makeTempDir('cd-src-');
    write(workspace, '.claude/skills/notes/SKILL.md', 'identical content');
    write(sourceRoot, '.claude/skills/notes/SKILL.md', 'identical content');
    const planMsg = realReply(workspace, 'plan_package_import', {
      sourcePath: sourceRoot, source: { id: sourceRoot, reference: null },
    });
    const out = model.reply(model.submit(model.initial(), sourceRoot).state, planMsg);
    const row = model.reviewCopy(out.state).rows.filter((r) => r.id === 'skill:notes')[0];
    assert.strictEqual(row.rowClass, 'collision');
    assert.match(row.compare.have, /identical to what arrives/);
    assert.match(row.compare.arrives, /byte for byte what you have/);
    // Decided overwrite, the evaluator puts it in `unchanged`, not `writes`,
    // and the confirm label must not warn about destroying something that
    // will not be written: zero overwrites, one unchanged, nothing added.
    const decided = projected(workspace, model.setDecision(out.state, 'skill:notes', 'overwrite'));
    const copy = model.reviewCopy(decided);
    assert.strictEqual(copy.counts.overwrites, 0);
    assert.strictEqual(copy.counts.unchanged, 1);
    assert.strictEqual(copy.confirmLabel, '1 unchanged, nothing added');
    assert.strictEqual(copy.rows[0].unchanged, true, 'the row says the bytes match, from the projection');
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

  test('the danger tone the model claims is bound to the one CSS carrier that actually paints it', () => {
    // REVIEW_TONES and the data-tone attribute it feeds are markup for tests
    // to read; no selector on this surface matches [data-tone]. What a
    // person actually sees comes from the class-based rules below, so this
    // walk reads those rules directly rather than trusting the model's own
    // claim about itself. A second review-surface rule reaching for
    // var(--danger) turns this red even though REVIEW_TONES never changes.
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'views', 'settings.css'), 'utf8');
    // Scoped to the review card's own section (through the stale card at
    // the end of the file), not every packages-prefixed rule in the
    // stylesheet: the field error and failed-state cards are earlier,
    // separate states this walk is not about.
    const stripped = css.slice(css.indexOf('/* The collision review card.')).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(stripped.length > 100, 'the review card section marker moved; update this slice to match');
    const rules = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map(([, selector, body]) => ({ selector: selector.trim(), body }));
    assert.ok(rules.length > 10, 'the parse found the review-surface rules; an empty read here is a broken instrument');
    const dangerSelectors = rules.filter(({ body }) => body.includes('var(--danger)')).map((r) => r.selector).sort();
    assert.deepStrictEqual(dangerSelectors, ['.packages-stale-body', '.packages-stale-card'],
      'a second review-surface rule now reaches for the danger token; the tone walk holds this to exactly the voided review');
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
    const before = workspaceTree(workspace);
    assert.throws(() => applyImport(workspace, sourceRoot, approval, {
      afterStep: () => { throw new Error('power gone mid-apply'); },
    }), /power gone/);
    // The atomicity promise itself: the workspace right after the failure,
    // not after some later recovery, equals the workspace right before the
    // attempt. Every path and every byte, including the absence of a
    // receipts directory and of any journal-visible content the failed
    // transaction might have left behind.
    assert.deepStrictEqual(workspaceTree(workspace), before);
    // The next apply recovers the interrupted transaction before looking, so
    // the workspace reads as it did before anything started, and can proceed
    // as its own, separate claim, not as the proof of rollback above.
    const result = applyImport(workspace, sourceRoot, approval, { receipt: {} });
    assert.strictEqual(result.status, 'ready');
    assert.notDeepStrictEqual(workspaceTree(workspace), before,
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

  // Amendment R1 to the receipts addendum: the zero-write shortcut governs
  // destination files, never the decision record. A person who skipped
  // everything still confirmed decisions, and that is what a receipt records;
  // only a pure replay, every item already at its approved bytes, records
  // nothing, because nothing was decided and nothing can be proven about who
  // wrote what is there.
  test('an all-skip apply writes a receipt recording every decision, in the same transaction', () => {
    const { workspace, sourceRoot, planMsg } = collidingScenario({
      extraSources: [['.claude/skills/writer/SKILL.md', 'incoming skill']],
      extraWorkspace: [['.claude/skills/writer/SKILL.md', 'existing skill']],
    });
    const approval = decide(planMsg.plan, { 'agent:helper': 'skip', 'skill:writer': 'skip' });
    const before = workspaceTree(workspace);
    const result = applyImport(workspace, sourceRoot, approval, { receipt: {} });
    assert.strictEqual(result.status, 'ready');
    assert.deepStrictEqual(result.writes, [], 'nothing reaches a destination');
    assert.ok(result.receipt, 'the decision record is written anyway');
    const receipt = JSON.parse(fs.readFileSync(path.join(workspace, result.receipt), 'utf8'));
    assert.deepStrictEqual(receipt.items.map((i) => [i.id, i.decision, i.outcome]),
      [['agent:helper', 'skip', 'skipped'], ['skill:writer', 'skip', 'skipped']]);
    // The receipt is the transaction's one write: the tree differs from
    // before by exactly that file and nothing else.
    const added = workspaceTree(workspace).filter((line) => !before.includes(line));
    assert.deepStrictEqual(added.map((line) => line.split(':')[0]), [result.receipt]);
    assert.throws(() => applyImport(workspace, sourceRoot, approval, {
      receipt: {}, afterStep: () => { throw new Error('mid-apply'); },
    }), /mid-apply/);
    assert.strictEqual(fs.readdirSync(path.join(workspace, '.claude/rundock/receipts')).length, 1,
      'a receipt lands only with the transaction that carries it');
  });

  test('a pure replay of an applied approval leaves the receipts directory as it was', () => {
    const { workspace, sourceRoot, planMsg } = collidingScenario();
    const approval = decide(planMsg.plan, { 'agent:helper': 'overwrite' });
    assert.ok(applyImport(workspace, sourceRoot, approval, { receipt: {} }).receipt);
    const before = workspaceTree(workspace);
    const replay = applyImport(workspace, sourceRoot, approval, { receipt: {} });
    assert.deepStrictEqual(replay.unchanged.map((u) => u.id), ['agent:helper']);
    assert.strictEqual(replay.receipt, null);
    assert.deepStrictEqual(workspaceTree(workspace), before);
  });
});

describe('the confirm label says what pressing it will actually do', () => {
  test('the three shapes from the review: mixed, blocked, and everything skipped', () => {
    assert.strictEqual(model.confirmLabel({ adds: 2, overwrites: 1, unchanged: 0, skips: 1, blocked: 0 }),
      'Add 2, overwrite 1, skip 1');
    assert.strictEqual(model.confirmLabel({ adds: 1, overwrites: 1, unchanged: 0, skips: 0, blocked: 2 }),
      'Add 1, overwrite 1, 2 blocked');
    assert.strictEqual(model.confirmLabel({ adds: 0, overwrites: 0, unchanged: 0, skips: 4, blocked: 0 }),
      'Skip 4, nothing added');
    assert.strictEqual(model.confirmLabel({ adds: 0, overwrites: 0, unchanged: 1, skips: 1, blocked: 0 }),
      'Skip 1, 1 unchanged, nothing added');
    assert.strictEqual(model.confirmLabel(null), 'Checking your decisions…');
  });

  test('the counts come from the projection alone: they change with it and stay when only local decisions change', () => {
    const { workspace, offer, firstSend } = collidingScenario({
      extraSources: [['.claude/skills/writer/SKILL.md', 'incoming skill']],
    });
    // Before the projection lands nothing is counted, and the label says so
    // rather than guessing from decisions.
    assert.strictEqual(model.reviewCopy(offer).counts, null);
    assert.strictEqual(model.reviewCopy(offer).confirmLabel, 'Checking your decisions…');
    const first = projected(workspace, { state: offer, send: firstSend });
    assert.deepStrictEqual(model.reviewCopy(first).counts, { adds: 1, overwrites: 0, unchanged: 0, skips: 1, blocked: 0 });
    assert.strictEqual(model.reviewCopy(first).confirmLabel, 'Add 1, skip 1');
    // The same projection with a different local decision counts the same.
    const decidedElsewhere = { ...first, decisions: { ...first.decisions, 'agent:helper': 'overwrite' } };
    assert.deepStrictEqual(model.reviewCopy(decidedElsewhere).counts, model.reviewCopy(first).counts);
    // A new projection, for the decision actually made, is what moves them.
    const flipped = model.setDecision(first, 'agent:helper', 'overwrite');
    assert.strictEqual(model.reviewCopy(flipped.state).counts, null, 'a decision change voids the old projection');
    const second = projected(workspace, flipped);
    assert.deepStrictEqual(model.reviewCopy(second).counts, { adds: 1, overwrites: 1, unchanged: 0, skips: 0, blocked: 0 });
    assert.strictEqual(model.reviewCopy(second).confirmLabel, 'Add 1, overwrite 1');
  });
});
