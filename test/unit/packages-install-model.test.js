'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const model = require('../../public/packages-install-model.js');
const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const config = require('../../lib/config.js');
const { makeTempDir } = require('../helpers/workspace.js');

const AGENT_TEXT = '---\nname: scribe\n---\n\nS.\n';

// Every reply shape the model consumes below is produced by the REAL
// protocol handlers driven through the real dispatch table, so a renamed
// field, status or reason code on the wire turns this suite red.
function realReply(workspace, type, payload) {
  const original = config.getWorkspace();
  config.setWorkspace(workspace);
  try {
    const sent = [];
    // The context carries the roster cache cascade the apply path tells,
    // inert here; the invalidation itself is pinned by the protocol suites.
    const ctx = { agents: { invalidateAgentCache() {}, flagRosterRefresh() {} } };
    buildDispatch()[type](ctx, { send: (m) => sent.push(JSON.parse(m)), readyState: 1 }, JSON.parse(JSON.stringify({ type, ...payload })));
    return sent[0];
  } finally {
    config.setWorkspace(original);
  }
}

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

// A real plan REPLY from the real handler through the real dispatch table,
// entering the model through its single reply entry, so a renamed reply type
// or envelope field turns this suite red.
function realPlanMsg({ withCollision = false } = {}) {
  const workspace = makeTempDir('pim-ws-');
  const sourceRoot = makeTempDir('pim-src-');
  write(sourceRoot, '.claude/agents/scribe.md', '---\nname: scribe\n---\n\nS.\n');
  write(sourceRoot, '.claude/skills/writer/SKILL.md', 'skill');
  if (withCollision) write(workspace, '.claude/skills/writer/SKILL.md', 'existing');
  const planMsg = realReply(workspace, 'plan_package_import', { sourcePath: sourceRoot, source: { id: sourceRoot, reference: null } });
  return { workspace, sourceRoot, planMsg };
}

// The typed-path handler's replies carry their operation like every other,
// so the one flow reads them through its correlation rule with no token.
const waitingOn = (operation) => ({ link: 'someone/pack', reference: '', outstanding: { operation, token: null } });

function offered(planMsg) {
  const submitted = model.submit(model.initial(), 'someone/pack');
  return model.reply(submitted.state, planMsg).state;
}

describe('nothing is silent', () => {
  test('submit sends the plan request; a blank link refuses without sending', () => {
    const blank = model.submit(model.initial(), '   ');
    assert.strictEqual(blank.send, undefined);
    assert.match(blank.state.fieldError, /Paste the GitHub link/);
    const ok = model.submit(model.initial(), ' someone/pack@v1 ');
    assert.deepStrictEqual(ok.send, { type: 'plan_package_install', url: 'someone/pack@v1' },
      'the link is the whole request; a reference rides inside it and the server resolves the rest');
    assert.strictEqual(ok.state.phase, 'classifying');
  });

  test('cancel sends nothing and returns to idle', () => {
    const state = offered(realPlanMsg().planMsg);
    const out = model.cancel(state);
    assert.strictEqual(out.send, undefined);
    assert.deepStrictEqual(out.state, model.initial());
  });

  test('confirm outside the offer phase sends nothing', () => {
    for (const state of [model.initial(), { phase: 'classifying', sourcePath: '/p' }, { phase: 'applying', sourcePath: '/p' }]) {
      assert.strictEqual(model.confirm(state).send, undefined);
    }
  });
});

describe('the offer', () => {
  test('states counts and the not-sandboxed sentence on the plain confirm card', () => {
    const copy = model.offerCopy(offered(realPlanMsg().planMsg));
    assert.strictEqual(copy.headline, 'Ready to add');
    assert.match(copy.body, /^Rundock found 1 agent and 1 skill built for Claude Code\. /);
    assert.match(copy.body, /They're not sandboxed: once added they act with the same access your own agents have\./);
    assert.match(copy.body, /Nothing runs until you add them\./);
    assert.strictEqual(copy.confirmLabel, 'Add to my team');
  });

  // A routine in an incoming agent's frontmatter is a thing the install can
  // start: the scheduler picks it up through ordinary agent discovery the
  // moment the file lands. So the offer must name it before the person
  // answers, in words that state the cadence and when it first runs. The
  // plan reply below comes from the real handler, so removing the routine
  // parse from the planner turns these red.
  test('a routine carried in an incoming agent is named on the offer, cadence in plain words and first run stated', () => {
    const workspace = makeTempDir('pim-ws-');
    const sourceRoot = makeTempDir('pim-src-');
    write(sourceRoot, '.claude/agents/executive-assistant.md',
      '---\nname: executive-assistant\nroutines:\n  - name: Tidy yesterday\'s notes\n    schedule: every day at 08:00\n    prompt: Tidy them.\n    enabled: true\n---\n\nBea.\n');
    write(sourceRoot, '.claude/skills/clean-a-note/SKILL.md', 'skill');
    const planMsg = realReply(workspace, 'plan_package_import', { sourcePath: sourceRoot, source: { id: sourceRoot, reference: null } });
    const copy = model.offerCopy(offered(planMsg));
    assert.match(copy.body, /1 routine arrives with them: /);
    assert.match(copy.body, /executive-assistant carries the routine "Tidy yesterday's notes"/);
    assert.match(copy.body, /it will run itself every day at 08:00/);
    assert.match(copy.body, /beginning at the first 08:00 after it is added/);
  });

  test('a weekly routine names its day; one that arrives switched off is disclosed as running nothing', () => {
    const workspace = makeTempDir('pim-ws-');
    const sourceRoot = makeTempDir('pim-src-');
    write(sourceRoot, '.claude/agents/reporter.md',
      '---\nname: reporter\nroutines:\n  - name: Weekly digest\n    schedule: every monday at 07:00\n    prompt: Digest.\n    enabled: true\n---\n\nR.\n');
    write(sourceRoot, '.claude/agents/sleeper.md',
      '---\nname: sleeper\nroutines:\n  - name: Night sweep\n    schedule: every day at 02:00\n    prompt: Sweep.\n---\n\nS.\n');
    const planMsg = realReply(workspace, 'plan_package_import', { sourcePath: sourceRoot, source: { id: sourceRoot, reference: null } });
    const copy = model.offerCopy(offered(planMsg));
    assert.match(copy.body, /2 routines arrive with them: /);
    assert.match(copy.body, /beginning on the first Monday at 07:00 after it is added/);
    // An `enabled` key the file does not carry reads as not enabled, the
    // scheduler's own rule, so the words must not claim this one runs.
    assert.match(copy.body, /sleeper carries the routine "Night sweep", scheduled every day at 02:00; it arrives switched off and runs nothing until it is turned on in Routines\./);
  });

  test('an agent carrying no routine adds no line: the absence is as honest as the presence', () => {
    const copy = model.offerCopy(offered(realPlanMsg().planMsg));
    assert.doesNotMatch(copy.body, /routine/i);
  });

  test('a real empty-package refusal classifies by its code, other real refusals as failure', () => {
    const workspace = makeTempDir('pim-ws-');
    const emptyRoot = makeTempDir('pim-src-');
    fs.mkdirSync(path.join(emptyRoot, '.claude'), { recursive: true });
    const classifying = model.submit(model.initial(), 'someone/pack').state;
    const emptyMsg = realReply(workspace, 'plan_package_import', { sourcePath: emptyRoot, source: { id: emptyRoot, reference: null } });
    assert.strictEqual(emptyMsg.code, 'empty-package');
    assert.strictEqual(model.reply(classifying, emptyMsg).state.phase, 'nothing-usable');

    const badRoot = makeTempDir('pim-src-');
    write(badRoot, 'real.md', AGENT_TEXT);
    fs.mkdirSync(path.join(badRoot, '.claude/agents'), { recursive: true });
    fs.symlinkSync(path.join(badRoot, 'real.md'), path.join(badRoot, '.claude/agents/link.md'));
    const badMsg = realReply(workspace, 'plan_package_import', { sourcePath: badRoot, source: { id: badRoot, reference: null } });
    const failed = model.reply(classifying, badMsg);
    assert.strictEqual(failed.state.phase, 'failed');
    assert.match(failed.state.message, /is a symlink/);
  });
});

describe('collisions enter review, decided skip', () => {
  test('a colliding plan starts every collision as skip and asks the server to project it', () => {
    const { planMsg } = realPlanMsg({ withCollision: true });
    const submitted = model.submit(model.initial(), '/tmp/somewhere');
    const out = model.reply(submitted.state, planMsg);
    assert.strictEqual(out.state.phase, 'offer');
    // Nothing is silently overwritten: skip is the default the review opens
    // with, and overwrite always requires a deliberate switch.
    assert.strictEqual(out.state.decisions['skill:writer'], 'skip');
    assert.strictEqual(out.send.type, 'evaluate_package_decisions');
    assert.strictEqual(out.send.approval.items.filter((i) => i.id === 'skill:writer')[0].decision, 'skip');
    // Confirming an untouched review keeps what the person already has.
    const confirmed = model.confirm(out.state);
    assert.strictEqual(confirmed.send.type, 'confirm_package_install');
    assert.strictEqual(confirmed.send.approval.items.filter((i) => i.id === 'skill:writer')[0].decision, 'skip');
  });
});

describe('the approval is the plan module\'s own decision', () => {
  test('confirm sends decide(plan, all-add) byte for byte, through the shared module itself', () => {
    const { planMsg } = realPlanMsg();
    const state = offered(planMsg);
    // The shared module is a require-cache singleton, so tagging its export
    // proves the model's call goes THROUGH it: a faithful local copy of the
    // construction produces equal bytes but no tag, and turns this red.
    const shared = require('../../public/packages-decide.js');
    const realDecide = shared.decide;
    shared.decide = (p, d) => ({ ...realDecide(p, d), viaSharedDecide: true });
    let out;
    try {
      out = model.confirm(state);
    } finally {
      shared.decide = realDecide;
    }
    assert.strictEqual(out.send.type, 'confirm_package_install');
    assert.strictEqual(out.send.approval.viaSharedDecide, true);
    const allAdd = {};
    for (const item of planMsg.plan.items) allAdd[item.id] = 'add';
    const { viaSharedDecide, ...approval } = out.send.approval;
    assert.deepStrictEqual(approval, decide(planMsg.plan, allAdd));
    assert.strictEqual(out.state.phase, 'applying');
  });
});

describe('outcomes are rendered honestly, against real apply replies', () => {
  // One real flow end to end: seed, plan through the real handler, decide,
  // optionally disturb the world, then apply through the real handler and
  // hand the model the exact reply that crossed the wire.
  function realApplyFlow({ sources = null, prepare = null, tamper = null } = {}) {
    const workspace = makeTempDir('pim-ws-');
    const sourceRoot = makeTempDir('pim-src-');
    for (const [rel, content] of sources || [
      ['.claude/agents/scribe.md', AGENT_TEXT],
      ['.claude/skills/writer/SKILL.md', 'skill'],
    ]) write(sourceRoot, rel, content);
    const planMsg = realReply(workspace, 'plan_package_import', { sourcePath: sourceRoot, source: { id: sourceRoot, reference: null } });
    const decisions = {};
    for (const item of planMsg.plan.items) decisions[item.id] = 'add';
    const approval = decide(planMsg.plan, decisions);
    if (tamper) tamper(approval);
    if (prepare) prepare({ workspace, sourceRoot });
    const replyMsg = realReply(workspace, 'apply_package_import', { sourcePath: sourceRoot, approval });
    return { workspace, applying: { phase: 'applying', ...waitingOn('apply') }, replyMsg };
  }

  test('a real ready reply names every written item, its destination, and the real receipt', () => {
    const { workspace, applying, replyMsg } = realApplyFlow();
    const done = model.reply(applying, replyMsg).state;
    const copy = model.doneCopy(done);
    assert.strictEqual(copy.headline, 'Added to your team');
    // Destinations come from the handler-produced writes, not restated by
    // hand: dropping or emptying them turns this red.
    assert.deepStrictEqual(copy.parts, replyMsg.writes.map((w) => ({
      label: w.id.split(':')[1], kind: w.kind, destination: w.destination,
    })));
    assert.deepStrictEqual(copy.parts.map((p) => p.destination),
      ['.claude/agents/scribe.md', '.claude/skills/writer']);
    assert.deepStrictEqual(copy.blockedLines, []);
    assert.match(done.receipt, /^\.rundock\/receipts\//);
    assert.strictEqual(fs.existsSync(path.join(workspace, done.receipt)), true);
  });

  test('real blocked outcomes are named with their reason in plain language', () => {
    const { applying, replyMsg } = realApplyFlow({
      sources: [
        ['.claude/agents/alpha.md', '---\norder: 0\n---\n\nA.\n'],
        ['.claude/agents/beta.md', '---\norder: 0\n---\n\nB.\n'],
        ['.claude/skills/writer/SKILL.md', 'skill'],
      ],
    });
    assert.strictEqual(replyMsg.status, 'ready');
    const copy = model.doneCopy(model.reply(applying, replyMsg).state);
    assert.deepStrictEqual(copy.blockedLines, [
      'alpha: not added, because this would give your team a second default agent',
      'beta: not added, because this would give your team a second default agent',
    ]);
  });

  test('a real decisions-blocked reply says plainly that nothing was added', () => {
    const { applying, replyMsg } = realApplyFlow({
      sources: [
        ['.claude/agents/alpha.md', '---\norder: 0\n---\n\nA.\n'],
        ['.claude/agents/beta.md', '---\norder: 0\n---\n\nB.\n'],
      ],
    });
    assert.strictEqual(replyMsg.status, 'decisions-blocked');
    assert.strictEqual(model.doneCopy(model.reply(applying, replyMsg).state).headline, 'Nothing was added');
  });

  test('a real stale reply becomes a failure naming what changed, with a re-plan path', () => {
    const { applying, replyMsg } = realApplyFlow({
      prepare: ({ workspace }) => write(workspace, '.claude/agents/scribe.md', 'arrived after planning'),
    });
    assert.strictEqual(replyMsg.status, 'stale');
    const failed = model.reply(applying, replyMsg).state;
    assert.strictEqual(failed.phase, 'failed');
    assert.match(failed.message, /scribe, because the workspace changed after you reviewed it/);
    assert.strictEqual(failed.canReplan, true);
    const retried = model.retry(failed);
    assert.strictEqual(retried.send.type, 'plan_package_install');
  });

  test('a real apply error reaches the rendered failure copy from the applying phase', () => {
    const { applying, replyMsg } = realApplyFlow({
      tamper: (approval) => { approval.items[0].approvedDigest = 'sha256:' + 'ab'.repeat(32); },
    });
    assert.strictEqual(replyMsg.type, 'package_import_error');
    const failed = model.reply(applying, replyMsg).state;
    assert.strictEqual(failed.phase, 'failed');
    assert.match(failed.message, /do not match the approved digest/);
  });

  test('a dropped connection ends either wait honestly, and touches nothing else', () => {
    const classifying = { phase: 'classifying', sourcePath: '/pkg' };
    const lostPlan = model.connectionLost(classifying).state;
    assert.strictEqual(lostPlan.phase, 'failed');
    assert.match(lostPlan.message, /connection dropped before an answer arrived/);
    assert.strictEqual(lostPlan.canReplan, true);
    const lostApply = model.connectionLost({ phase: 'applying', sourcePath: '/pkg' }).state;
    assert.strictEqual(lostApply.phase, 'failed');
    // Neither success nor failure is claimed for a write that may have landed.
    assert.match(lostApply.message, /may or may not have completed/);
    assert.match(lostApply.message, /receipts/);
    assert.strictEqual(lostApply.canReplan, true);
    for (const state of [model.initial(), { phase: 'offer', link: 'p', reference: '' }, { phase: 'stale', link: 'p', reference: '', token: null }]) {
      assert.strictEqual(model.connectionLost(state).state, state);
    }
  });

  test('replies outside their phase change nothing', () => {
    const idle = model.initial();
    assert.strictEqual(model.reply(idle, { type: 'package_import_plan', plan: {} }).state, idle);
    assert.strictEqual(model.reply(idle, { type: 'package_import_result', status: 'ready' }).state, idle);
  });
});

// ---- Starter files on the offer and the review ----
//
// A package's starter/ folder lands files of the person's own. The offer
// names each by path, says they land only where nothing exists and stay the
// person's, and a path already taken is named as kept, with no way anywhere
// to overwrite it. Driven from real plan replies.
function starterPlanMsg({ taken = false, skillCollision = false } = {}) {
  const workspace = makeTempDir('pim-starter-ws-');
  const sourceRoot = makeTempDir('pim-starter-src-');
  write(sourceRoot, '.claude/agents/scribe.md', AGENT_TEXT);
  write(sourceRoot, '.claude/skills/writer/SKILL.md', 'skill');
  write(sourceRoot, 'starter/Investments/Portfolio.md', '# Portfolio\n');
  write(sourceRoot, 'starter/Investments/Watchlist.md', '# Watch\n');
  if (taken) write(workspace, 'Investments/Portfolio.md', 'mine');
  if (skillCollision) write(workspace, '.claude/skills/writer/SKILL.md', 'existing');
  const planMsg = realReply(workspace, 'plan_package_import', { sourcePath: sourceRoot, source: { id: sourceRoot, reference: null } });
  return { workspace, sourceRoot, planMsg };
}

describe('starter files', () => {
  test('the offer lists each starter file by path and says whose they are, without counting them as agents or skills', () => {
    const copy = model.offerCopy(offered(starterPlanMsg().planMsg));
    assert.match(copy.body, /^Rundock found 1 agent and 1 skill built for Claude Code\. /);
    assert.match(copy.body, /Starter files: Investments\/Portfolio\.md, Investments\/Watchlist\.md\./);
    assert.match(copy.body, /added only where you have nothing at that path/);
    assert.match(copy.body, /removing the package never removes them/);
  });

  test('a starter path already taken is named as kept on the offer, and does not open the review on its own', () => {
    const state = offered(starterPlanMsg({ taken: true }).planMsg);
    assert.strictEqual(state.review, false, 'there is nothing to decide about a starter file that is kept');
    assert.strictEqual(state.decisions['starter:Investments/Portfolio.md'], 'skip');
    const copy = model.offerCopy(state);
    assert.match(copy.body, /Starter files: Investments\/Watchlist\.md\./);
    assert.match(copy.body, /Already in your workspace, so yours is kept: Investments\/Portfolio\.md\./);
  });

  test('a kept starter file can never be switched to overwrite', () => {
    const state = offered(starterPlanMsg({ taken: true }).planMsg);
    const out = model.setDecision({ ...state, review: true }, 'starter:Investments/Portfolio.md', 'overwrite');
    assert.strictEqual(out.state.decisions['starter:Investments/Portfolio.md'], 'skip');
    assert.strictEqual(out.send, undefined, 'a refused change asks nothing of the server');
  });

  test('on the review a kept starter file has its own row, saying so, with no decision to make', () => {
    const { planMsg } = starterPlanMsg({ taken: true, skillCollision: true });
    const state = offered(planMsg);
    assert.strictEqual(state.review, true, 'the colliding skill opens the review');
    const copy = model.reviewCopy(state);
    const kept = copy.rows.find((r) => r.id === 'starter:Investments/Portfolio.md');
    assert.strictEqual(kept.rowClass, 'kept');
    assert.strictEqual(kept.kind, 'starter file');
    assert.strictEqual(kept.name, 'Investments/Portfolio.md');
    assert.match(kept.keptNote, /yours is kept/);
    assert.strictEqual(kept.compare, null, 'nothing to compare where nothing will be replaced');
    const added = copy.rows.find((r) => r.id === 'starter:Investments/Watchlist.md');
    assert.strictEqual(added.rowClass, 'willAdd');
    assert.strictEqual(added.kind, 'starter file');
  });
});

