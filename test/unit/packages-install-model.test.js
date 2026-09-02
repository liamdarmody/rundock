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
    buildDispatch()[type]({}, { send: (m) => sent.push(JSON.parse(m)), readyState: 1 }, JSON.parse(JSON.stringify({ type, ...payload })));
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

function offered(planMsg) {
  const submitted = model.submit(model.initial(), '/tmp/somewhere');
  return model.reply(submitted.state, planMsg).state;
}

describe('nothing is silent', () => {
  test('submit sends the plan request; a blank path refuses without sending', () => {
    const blank = model.submit(model.initial(), '   ');
    assert.strictEqual(blank.send, undefined);
    assert.match(blank.state.fieldError, /Enter the path/);
    const ok = model.submit(model.initial(), ' /pkg ');
    assert.deepStrictEqual(ok.send, {
      type: 'plan_package_import', sourcePath: '/pkg', source: { id: '/pkg', reference: null },
    });
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
    assert.strictEqual(copy.headline, "This isn't a Rundock package");
    assert.match(copy.body, /^Rundock found 1 agent and 1 skill built for Claude Code\. /);
    assert.match(copy.body, /They're not sandboxed: once added they act with the same access your own agents have\./);
    assert.match(copy.body, /Nothing runs until you add them\./);
    assert.strictEqual(copy.confirmLabel, 'Add to my team');
    assert.strictEqual(copy.confirmDisabled, false);
    assert.strictEqual(copy.collisionNote, null);
  });

  test('a real empty-package refusal classifies by its code, other real refusals as failure', () => {
    const workspace = makeTempDir('pim-ws-');
    const emptyRoot = makeTempDir('pim-src-');
    fs.mkdirSync(path.join(emptyRoot, '.claude'), { recursive: true });
    const classifying = model.submit(model.initial(), emptyRoot).state;
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

describe('collisions fail closed', () => {
  test('any colliding item disables confirm and names itself, and confirm can never send', () => {
    const state = offered(realPlanMsg({ withCollision: true }).planMsg);
    const copy = model.offerCopy(state);
    assert.strictEqual(copy.confirmDisabled, true);
    assert.match(copy.collisionNote, /writer/);
    assert.match(copy.collisionNote, /keep-or-replace decision/);
    assert.match(copy.collisionNote, /does not offer yet/);
    // Exhaustion: no sequence of the model's public actions can produce an
    // apply message from a colliding plan.
    assert.strictEqual(model.confirm(state).send, undefined);
    assert.strictEqual(model.confirm(model.confirm(state).state).send, undefined);
    assert.strictEqual(model.applyReply(state, { type: 'package_import_result', status: 'ready', writes: [] }).state, state);
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
    assert.strictEqual(out.send.type, 'apply_package_import');
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
    return { workspace, applying: { phase: 'applying', sourcePath: sourceRoot }, replyMsg };
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
    assert.match(done.receipt, /^\.claude\/rundock\/receipts\//);
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
    assert.strictEqual(retried.send.type, 'plan_package_import');
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

  test('replies outside their phase change nothing', () => {
    const idle = model.initial();
    assert.strictEqual(model.reply(idle, { type: 'package_import_plan', plan: {} }).state, idle);
    assert.strictEqual(model.reply(idle, { type: 'package_import_result', status: 'ready' }).state, idle);
  });
});
