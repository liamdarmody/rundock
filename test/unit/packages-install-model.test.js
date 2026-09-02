'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const model = require('../../public/packages-install-model.js');
const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
const { makeTempDir } = require('../helpers/workspace.js');

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

// A real plan from the real plan module, so every fixture the model consumes
// carries the exact shape the wire will.
function realPlan({ withCollision = false } = {}) {
  const workspace = makeTempDir('pim-ws-');
  const sourceRoot = makeTempDir('pim-src-');
  write(sourceRoot, '.claude/agents/scribe.md', '---\nname: scribe\n---\n\nS.\n');
  write(sourceRoot, '.claude/skills/writer/SKILL.md', 'skill');
  if (withCollision) write(workspace, '.claude/skills/writer/SKILL.md', 'existing');
  return buildPlan(workspace, sourceRoot, { id: sourceRoot, reference: null });
}

function offered(plan) {
  const submitted = model.submit(model.initial(), '/tmp/somewhere');
  return model.planReply(submitted.state, { type: 'package_import_plan', plan }).state;
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
    const state = offered(realPlan());
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
    const copy = model.offerCopy(offered(realPlan()));
    assert.strictEqual(copy.headline, "This isn't a Rundock package");
    assert.match(copy.body, /^Rundock found 1 agent and 1 skill built for Claude Code\. /);
    assert.match(copy.body, /They're not sandboxed: once added they act with the same access your own agents have\./);
    assert.match(copy.body, /Nothing runs until you add them\./);
    assert.strictEqual(copy.confirmLabel, 'Add to my team');
    assert.strictEqual(copy.confirmDisabled, false);
    assert.strictEqual(copy.collisionNote, null);
  });

  test('a nothing-usable refusal renders as its own state, other errors as failure', () => {
    const classifying = model.submit(model.initial(), '/pkg').state;
    const empty = model.planReply(classifying, {
      type: 'package_import_error', operation: 'plan', message: 'package discovery refused: the package contains no agents and no skills',
    });
    assert.strictEqual(empty.state.phase, 'nothing-usable');
    const failed = model.planReply(classifying, {
      type: 'package_import_error', operation: 'plan', message: 'package discovery refused: agents/link.md is a symlink',
    });
    assert.strictEqual(failed.state.phase, 'failed');
    assert.match(failed.state.message, /is a symlink/);
  });
});

describe('collisions fail closed', () => {
  test('any colliding item disables confirm and names itself, and confirm can never send', () => {
    const state = offered(realPlan({ withCollision: true }));
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
  test('confirm sends decide(plan, all-add) byte for byte', () => {
    const plan = realPlan();
    const state = offered(plan);
    const out = model.confirm(state);
    assert.strictEqual(out.send.type, 'apply_package_import');
    const allAdd = {};
    for (const item of plan.items) allAdd[item.id] = 'add';
    assert.deepStrictEqual(out.send.approval, decide(plan, allAdd));
    assert.strictEqual(out.state.phase, 'applying');
  });
});

describe('outcomes are rendered honestly', () => {
  const applying = { phase: 'applying', sourcePath: '/pkg' };

  test('a ready reply names every written item and its destination', () => {
    const done = model.applyReply(applying, {
      type: 'package_import_result',
      status: 'ready',
      writes: [
        { id: 'agent:scribe', kind: 'agent', destination: '.claude/agents/scribe.md' },
        { id: 'skill:writer', kind: 'skill', destination: '.claude/skills/writer' },
      ],
      blocked: [],
      receipt: '.claude/rundock/receipts/2026-09-02-run.json',
    }).state;
    const copy = model.doneCopy(done);
    assert.strictEqual(copy.headline, 'Added to your team');
    assert.deepStrictEqual(copy.parts, [
      { label: 'scribe', kind: 'agent', destination: '.claude/agents/scribe.md' },
      { label: 'writer', kind: 'skill', destination: '.claude/skills/writer' },
    ]);
    assert.deepStrictEqual(copy.blockedLines, []);
    assert.strictEqual(done.receipt, '.claude/rundock/receipts/2026-09-02-run.json');
  });

  test('blocked items are named with their reason in plain language', () => {
    const done = model.applyReply(applying, {
      type: 'package_import_result',
      status: 'ready',
      writes: [{ id: 'skill:writer', kind: 'skill', destination: '.claude/skills/writer' }],
      blocked: [
        { id: 'agent:alpha', reason: 'default-conflict' },
        { id: 'agent:beta', reason: 'default-conflict' },
      ],
      receipt: null,
    }).state;
    const copy = model.doneCopy(done);
    assert.deepStrictEqual(copy.blockedLines, [
      'alpha: not added, because this would give your team a second default agent',
      'beta: not added, because this would give your team a second default agent',
    ]);
  });

  test('a decisions-blocked reply says plainly that nothing was added', () => {
    const done = model.applyReply(applying, {
      type: 'package_import_result', status: 'decisions-blocked', writes: [],
      blocked: [{ id: 'agent:alpha', reason: 'default-conflict' }], receipt: null,
    }).state;
    assert.strictEqual(model.doneCopy(done).headline, 'Nothing was added');
  });

  test('a stale reply becomes a failure naming what changed, with a re-plan path', () => {
    const failed = model.applyReply(applying, {
      type: 'package_import_result', status: 'stale', writes: [],
      stale: [{ id: 'skill:writer', reason: 'destination-changed' }],
    }).state;
    assert.strictEqual(failed.phase, 'failed');
    assert.match(failed.message, /Nothing was added: writer, because the workspace changed after you reviewed it/);
    assert.strictEqual(failed.canReplan, true);
    const retried = model.retry(failed);
    assert.strictEqual(retried.send.type, 'plan_package_import');
    assert.strictEqual(retried.send.sourcePath, '/pkg');
  });

  test('apply errors render their structured message, never an empty error', () => {
    const failed = model.applyReply(applying, {
      type: 'package_import_error', operation: 'apply', message: 'bytes for agent:scribe do not match the approved digest; refusing to write',
    }).state;
    assert.strictEqual(failed.phase, 'failed');
    assert.match(failed.message, /do not match the approved digest/);
    const fallback = model.applyReply(applying, { type: 'package_import_error', operation: 'apply' }).state;
    assert.strictEqual(fallback.message, 'The import could not be applied.');
  });

  test('replies outside their phase change nothing', () => {
    const idle = model.initial();
    assert.strictEqual(model.planReply(idle, { type: 'package_import_plan', plan: {} }).state, idle);
    assert.strictEqual(model.applyReply(idle, { type: 'package_import_result', status: 'ready' }).state, idle);
  });
});
