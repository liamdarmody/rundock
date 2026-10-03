'use strict';
// A package carrying its own orchestrator, imported into a
// workspace that already has one, hits the default-conflict block. Before
// this card the blocked row's only way out was Skip, and after a skip the
// package's specialists still carried a reportsTo naming an orchestrator
// that never arrived, so the chart attached them at the root as peers of the
// existing leader: two individually correct behaviors composing into a wrong
// chart that looked right.
//
// The blocked row offers attaching the package's dependants to the
// existing leader, beside skipping. Evidence here: the RENDERED row carries
// both actions, and choosing attach re-points each dependant through the
// real evaluator and the real apply.
//
// A re-pointed dependant keeps its provenance line naming the package
// it came from, and the chart shows it under the existing leader rather than
// beside it. Evidence here: the RENDERED org chart is asserted, drawn by the
// product's own renderOrgChart over the product's own discovery of the
// applied workspace, not the data alone.
//
// The re-point is a write-time sibling of withProvenance, so the plan-side
// approved digest must cover the composed bytes: the digest tests below hold
// the two sides to one computation.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const model = require('../../public/packages-install-model.js');
const settings = require('../../public/views/settings.js');
const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
const { applyImport, withReportsTo } = require('../../lib/packages/import-apply.js');
const { evaluateImport } = require('../../lib/packages/import-evaluate.js');
const { snapshotCurrent } = require('../../lib/packages/import-apply.js');
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const config = require('../../lib/config.js');
const discovery = require('../../lib/agents/discovery.js');
const { makeTempDir } = require('../helpers/workspace.js');

const ROOT = path.join(__dirname, '..', '..');

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

// Every wire shape below is produced by the REAL handlers through the real
// dispatch table, the same technique the collision-decisions suite uses, so
// a renamed field or status on the wire turns this red rather than a copy of
// the wire quietly keeping up appearances.
const sourceRoots = new Map();
function realReply(workspace, type, payload) {
  const original = config.getWorkspace();
  config.setWorkspace(workspace);
  try {
    const sent = [];
    const message = { type, ...payload };
    if (message.token === null && message.sourcePath === undefined) message.sourcePath = sourceRoots.get(workspace);
    const ctx = { agents: { invalidateAgentCache() {}, flagRosterRefresh() {} } };
    buildDispatch()[type](ctx, { send: (m) => sent.push(JSON.parse(m)), readyState: 1 }, JSON.parse(JSON.stringify(message)));
    return sent[0];
  } finally {
    config.setWorkspace(original);
  }
}

const LEADER = '---\nname: cos\ndisplayName: Cos\nrole: Chief\ntype: orchestrator\norder: 0\n---\n\nChief of staff.\n';
const WREN = '---\nname: wren\ntype: orchestrator\norder: 0\n---\n\nContent lead.\n';
const SCOUT = '---\nname: scout\ntype: specialist\norder: 1\nreportsTo: wren\n---\n\nResearcher.\n';
const QUILL = '---\nname: quill\ntype: specialist\norder: 2\nreportsTo: wren\n---\n\nWriter.\n';

// The workspace already led by Cos, and a package led by its own
// orchestrator with two dependants naming it. One colliding skill opens the
// review, which is the surface the blocked treatment lives on.
function leaderScenario() {
  const workspace = makeTempDir('att-ws-');
  const sourceRoot = makeTempDir('att-src-');
  write(workspace, '.claude/agents/cos.md', LEADER);
  write(workspace, '.claude/skills/notes/SKILL.md', 'existing skill');
  write(sourceRoot, '.claude/agents/wren.md', WREN);
  write(sourceRoot, '.claude/agents/scout.md', SCOUT);
  write(sourceRoot, '.claude/agents/quill.md', QUILL);
  write(sourceRoot, '.claude/skills/notes/SKILL.md', 'incoming skill');
  sourceRoots.set(workspace, sourceRoot);
  const planMsg = realReply(workspace, 'plan_package_import', {
    sourcePath: sourceRoot, source: { id: sourceRoot, reference: null },
  });
  const submitted = model.submit(model.initial(), sourceRoot);
  const out = model.reply(submitted.state, planMsg);
  return { workspace, sourceRoot, planMsg, offer: out.state, firstSend: out.send };
}

function projected(workspace, out) {
  return model.reply(out.state, realReply(workspace, 'evaluate_package_decisions', out.send)).state;
}

function rowOf(state, id) {
  return model.reviewCopy(state).rows.filter((r) => r.id === id)[0];
}
function renderRow(state, id) {
  return settings.packagesReviewRowHtml(rowOf(state, id));
}

// The product's own reading of a workspace roster, through real discovery.
function rosterOf(workspace) {
  const original = config.getWorkspace();
  config.setWorkspace(workspace);
  discovery.invalidateAgentCache();
  try {
    return discovery.discoverAgents();
  } finally {
    config.setWorkspace(original);
    discovery.invalidateAgentCache();
  }
}

// The RENDERED org chart: the product's own renderOrgChart, run over a real
// roster in a real DOM with the vendored d3 the page itself loads, returning
// each card's on-screen position keyed by the agent id it renders for.
function renderedChart(roster) {
  const dom = new JSDOM('<!doctype html><html><body><div id="org-chart"></div></body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'd3-hierarchy', 'd3-hierarchy.min.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'public', 'views', 'team.js'), 'utf8'));
  const chart = w.document.getElementById('org-chart');
  Object.defineProperty(chart, 'clientWidth', { value: 1200 });
  Object.defineProperty(chart, 'clientHeight', { value: 800 });
  w.agents = roster;
  w.conversations = [];
  w.convoState = {};
  w.agentLastActivity = {};
  w.workspaceAnalysis = null;
  w.currentWorkspacePath = null;
  w.orgZoomOffset = 0;
  w.orgOrientation = 'vertical';
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.formatTimeAgo = () => 'a while ago';
  w.getTeamAgents = () => w.agents.filter((a) => a.status === 'onTeam' && a.type !== 'platform');
  w.getPlatformAgents = () => w.agents.filter((a) => a.status === 'onTeam' && a.type === 'platform');
  w.getGuide = () => null;
  w.requestAnimationFrame = () => {};
  w.renderOrgChart();
  const cards = {};
  for (const card of w.document.querySelectorAll('[data-org-agent]')) {
    cards[card.getAttribute('data-org-agent')] = {
      top: parseInt(card.style.top, 10),
      left: parseInt(card.style.left, 10),
    };
  }
  return cards;
}

describe('the blocked default row offers attaching beside skipping', () => {
  test('the rendered blocked row carries both actions, and choosing attach re-points each dependant', () => {
    const { workspace, offer, firstSend } = leaderScenario();
    const first = projected(workspace, { state: offer, send: firstSend });

    // The package's own orchestrator is blocked by the existing default.
    const row = rowOf(first, 'agent:wren');
    assert.strictEqual(row.rowClass, 'blocked');
    // Skipping wren carries scout and quill to Cos rather than
    // stranding them, and the control says so. There is no separate attach
    // control: this IS it.
    assert.deepStrictEqual(row.blockedAction, {
      label: 'Skip; team reports to Cos',
      decision: 'attach',
    }, 'the way out names what happens to the specialists');
    assert.strictEqual(row.attachAction, undefined,
      'no separate attach control survives the merge into skip');

    // The offered actions are RENDERED on the row, each as a pressable
    // control. Skip is not among them here, because scout and quill name
    // wren and are still arriving, so skipping it could only put them at the
    // top level. Asserted as an absence, since a control that should not
    // exist is exactly the kind of thing a positive-only test misses.
    const html = renderRow(first, 'agent:wren');
    assert.strictEqual(html.indexOf('data-decision="skip"'), -1,
      'the plain skip decision is not offered while specialists would be left behind');
    assert.match(html, /data-decision="attach"[^>]*>Skip; team reports to Cos</,
      'the blocked row renders the attach action');
    assert.match(html, /onclick="packagesSetDecision\(this\.closest\('\.packages-item-row'\)\.dataset\.item, this\.dataset\.decision\)"/,
      'the attach control goes through the same handler as every other decision');

    // Choosing attach clears the conflict in the real evaluator: the
    // orchestrator is skipped and both dependants become writes.
    const chosen = model.setDecision(first, 'agent:wren', 'attach');
    assert.strictEqual(chosen.state.decisions['agent:wren'], 'attach');
    assert.strictEqual(chosen.send.type, 'evaluate_package_decisions');
    const evalMsg = realReply(workspace, 'evaluate_package_decisions', chosen.send);
    assert.deepStrictEqual(evalMsg.blocked, []);
    assert.deepStrictEqual(evalMsg.skipped.map((s) => s.id).sort(), ['agent:wren', 'skill:notes']);
    assert.deepStrictEqual(evalMsg.writes.map((s) => s.id), ['agent:quill', 'agent:scout']);

    // The chosen row says what it will do, on the rendered row.
    const settled = model.reply(chosen.state, evalMsg).state;
    const chosenRow = rowOf(settled, 'agent:wren');
    assert.strictEqual(chosenRow.rowClass, 'skippedNew');
    assert.match(chosenRow.attachNote, /reports? to Cos/);
    assert.match(renderRow(settled, 'agent:wren'), /packages-attach-note/,
      'the chosen state reaches the rendered row');

    // Confirm applies through the real handler, and the chosen action
    // re-points EACH dependant in the written workspace.
    const confirmed = model.confirm(settled);
    const applyMsg = realReply(workspace, 'apply_package_import', confirmed.send);
    const done = model.reply(confirmed.state, applyMsg).state;
    assert.strictEqual(done.phase, 'done');
    assert.deepStrictEqual(done.written.map((w) => w.id), ['agent:quill', 'agent:scout']);
    assert.ok(!fs.existsSync(path.join(workspace, '.claude/agents/wren.md')),
      'the skipped orchestrator never lands');
    for (const slug of ['scout', 'quill']) {
      const written = fs.readFileSync(path.join(workspace, `.claude/agents/${slug}.md`), 'utf8');
      assert.ok(written.includes('\nreportsTo: cos\n'),
        `${slug} is re-pointed at the existing leader; got:\n${written}`);
      assert.ok(!written.includes('wren'), `${slug} no longer names the absent orchestrator`);
    }
  });

  test('attach is refused on an item that carries no attach offer', () => {
    const { workspace, offer, firstSend } = leaderScenario();
    const first = projected(workspace, { state: offer, send: firstSend });
    const refused = model.setDecision(first, 'agent:scout', 'attach');
    assert.strictEqual(refused.state, first, 'a dependant has no attach decision of its own');
    assert.strictEqual(refused.send, undefined);
  });
});

describe('a re-pointed dependant keeps provenance and hangs under the leader in the rendered chart', () => {
  // One applied workspace per path: attach on the blocked orchestrator, and
  // the old way out (plain skip) as the counterfactual the criterion names.
  function appliedWorkspace(orchestratorDecision) {
    const { workspace, sourceRoot, planMsg } = leaderScenario();
    const approval = decide(planMsg.plan, {
      'agent:wren': orchestratorDecision, 'agent:scout': 'add', 'agent:quill': 'add', 'skill:notes': 'skip',
    });
    const result = applyImport(workspace, sourceRoot, approval, { receipt: {} });
    assert.strictEqual(result.status, 'ready');
    assert.deepStrictEqual(result.writes.map((w) => w.id), ['agent:quill', 'agent:scout']);
    return { workspace, sourceRoot };
  }

  test('the written dependant keeps a provenance line naming the package, beside the re-point', () => {
    const { workspace, sourceRoot } = appliedWorkspace('attach');
    const written = fs.readFileSync(path.join(workspace, '.claude/agents/scout.md'), 'utf8');
    assert.ok(written.includes(`\nsource: ${sourceRoot}\n`),
      `the provenance line names the package the dependant came from; got:\n${written}`);
    assert.ok(written.includes('\nreportsTo: cos\n'), 'the re-point rides in the same frontmatter');
    // The product's own parser reads the composed frontmatter back whole.
    const meta = discovery.parseAgentFrontmatter(written);
    assert.strictEqual(meta.reportsTo, 'cos');
    assert.strictEqual(meta.source, sourceRoot);
  });

  test('the rendered chart places the dependants under the existing leader; a plain skip leaves them beside it', () => {
    const attached = renderedChart(rosterOf(appliedWorkspace('attach').workspace));
    // The leader's discovery id is `default`; the dependants keep their slugs.
    assert.ok(attached.default && attached.scout && attached.quill,
      `all three cards are rendered; got: ${Object.keys(attached).join(', ')}`);
    assert.ok(attached.scout.top > attached.default.top,
      `scout hangs UNDER the leader (scout top ${attached.scout.top}, leader top ${attached.default.top})`);
    assert.ok(attached.quill.top > attached.default.top,
      `quill hangs UNDER the leader (quill top ${attached.quill.top}, leader top ${attached.default.top})`);
    assert.strictEqual(attached.scout.top, attached.quill.top, 'the two dependants share one row');

    // The counterfactual the criterion names: skipped without attaching, the
    // dependants' reportsTo resolves to nobody and the chart seats them
    // BESIDE the leader at the root, which is the wrong chart that looks
    // right. Asserted so "under, not beside" is a rendered difference.
    const skipped = renderedChart(rosterOf(appliedWorkspace('skip').workspace));
    assert.strictEqual(skipped.scout.top, skipped.default.top,
      'without the re-point the dependant sits beside the leader, as a root peer');
  });
});

describe('the digest path covers the re-point transform', () => {
  test('the plan-side approved digest is derived from the exact composed bytes apply writes', () => {
    const { workspace, sourceRoot, planMsg } = leaderScenario();
    const scout = planMsg.plan.items.filter((i) => i.id === 'agent:scout')[0];
    assert.ok(scout.agent.repoint, 'the dependant carries its re-pointed variant as a plan fact');
    assert.strictEqual(scout.agent.repoint.to, 'cos');
    const approval = decide(planMsg.plan, {
      'agent:wren': 'attach', 'agent:scout': 'add', 'agent:quill': 'add', 'skill:notes': 'skip',
    });
    const decided = approval.items.filter((i) => i.id === 'agent:scout')[0];
    assert.strictEqual(decided.approvedDigest, scout.agent.repoint.approvedDigest,
      'the decision contract selects the re-pointed digest, once, for both sides');
    assert.strictEqual(decided.agent.attachTo, 'cos');
    // And apply verifies its own transformed bytes against that digest: the
    // written file hashes to what the plan promised, which the ready apply
    // in the default-agent walk already proves end to end.
    const result = applyImport(workspace, sourceRoot, approval, { receipt: {} });
    assert.strictEqual(result.status, 'ready');
    const writtenDigest = result.writes.filter((w) => w.id === 'agent:scout')[0].approvedDigest;
    assert.strictEqual(writtenDigest, scout.agent.repoint.approvedDigest);
  });

  test('an attachTo that does not hash to the approved digest is refused at write time', () => {
    const { workspace, sourceRoot, planMsg } = leaderScenario();
    const approval = decide(planMsg.plan, {
      'agent:wren': 'attach', 'agent:scout': 'add', 'agent:quill': 'add', 'skill:notes': 'skip',
    });
    for (const item of approval.items) {
      if (item.id === 'agent:scout') item.agent.attachTo = 'somebody-else';
    }
    assert.throws(() => applyImport(workspace, sourceRoot, approval, { receipt: {} }),
      /bytes for agent:scout do not match the approved digest; refusing to write/);
    assert.ok(!fs.existsSync(path.join(workspace, '.claude/agents/scout.md')),
      'nothing lands when the transform and the digest disagree');
  });

  test('the evaluator refuses an attachTo that is not a single-line string', () => {
    const { workspace, sourceRoot, planMsg } = leaderScenario();
    const decisions = { 'agent:wren': 'attach', 'agent:scout': 'add', 'agent:quill': 'add', 'skill:notes': 'skip' };
    for (const bad of ['nobody\norder: 0', '', 42]) {
      const approval = JSON.parse(JSON.stringify(decide(planMsg.plan, decisions)));
      for (const item of approval.items) {
        if (item.id === 'agent:scout') item.agent.attachTo = bad;
      }
      assert.throws(() => evaluateImport(approval, snapshotCurrent(workspace, sourceRoot, approval)),
        /attachTo/, `an attachTo of ${JSON.stringify(bad)} cannot reach the writer`);
    }
  });

  test('withReportsTo keeps the file\'s own line ending, drops a BOM, and refuses when there is nothing to re-point', () => {
    assert.strictEqual(
      withReportsTo('---\r\nname: a\r\nreportsTo: wren\r\n---\r\n\r\nBody.\r\n', 'cos'),
      '---\r\nname: a\r\nreportsTo: cos\r\n---\r\n\r\nBody.\r\n');
    assert.strictEqual(
      withReportsTo('\ufeff---\nname: a\nreportsTo: wren\n---\n\nBody.\n', 'cos'),
      '---\nname: a\nreportsTo: cos\n---\n\nBody.\n');
    assert.throws(() => withReportsTo('---\nname: a\n---\n\nBody.\n', 'cos'), /reportsTo/);
    assert.throws(() => withReportsTo('no frontmatter at all\n', 'cos'), /reportsTo|frontmatter/);
    assert.throws(() => withReportsTo('---\nname: a\nreportsTo: wren\n', 'cos'), /never closes/);
  });

  // The scenario that actually ships, and the one the default-agent rule was written for:
  // every agent in the package is new, so NOTHING collides, landing in a
  // workspace that already has a leader. This is lean-agent-team into a
  // populated workspace. leaderScenario above seeds a colliding skill, and
  // that collision is the only reason its review opens, so every test built
  // on it can pass while this case is unreachable.
  function noCollisionScenario() {
    const workspace = makeTempDir('att-nc-ws-');
    const sourceRoot = makeTempDir('att-nc-src-');
    write(workspace, '.claude/agents/cos.md', LEADER);
    write(sourceRoot, '.claude/agents/wren.md', WREN);
    write(sourceRoot, '.claude/agents/scout.md', SCOUT);
    write(sourceRoot, '.claude/agents/quill.md', QUILL);
    sourceRoots.set(workspace, sourceRoot);
    const planMsg = realReply(workspace, 'plan_package_import', {
      sourcePath: sourceRoot, source: { id: sourceRoot, reference: null },
    });
    const out = model.reply(model.submit(model.initial(), sourceRoot).state, planMsg);
    return { workspace, sourceRoot, offer: out.state, firstSend: out.send };
  }

  test('a package whose agents are all new still offers the attach, because a default conflict is a decision', () => {
    const { workspace, offer, firstSend } = noCollisionScenario();
    // Guard the scenario itself: with a collision present this proves nothing.
    assert.strictEqual(offer.collisions.length, 0,
      'this scenario must carry no collisions, or it is just leaderScenario again');
    const attach = offer.plan.items.filter((i) => i.agent && i.agent.attach);
    assert.deepStrictEqual(attach.map((i) => i.id), ['agent:wren'],
      'the plan finds the conflict and the leader whether or not anything collides');

    // The defect this test exists for: the plan computed the offer and the
    // surface threw it away, which is the computed-and-dropped class the install rules
    // forbids for refusals and which applies with equal force to an action.
    assert.strictEqual(offer.review, true,
      'a plan carrying an attach offer has a decision to make, so it opens the review');

    // And the offer survives all the way to the rendered row.
    const state = projected(workspace, { state: offer, send: firstSend });
    const html = renderRow(state, 'agent:wren');
    assert.match(html, /Skip; team reports to Cos/,
      'the way out reaches the row in the case that has no collision, naming where they go');
  });

  // The note beside the skip action said skipping "keeps your workspace
  // exactly as it is", which is false whenever the blocked default has
  // dependants: they land naming a leader that was never imported, so they
  // attach at the top level. The sentence talked a person into the outcome
  // this card exists to prevent, which is the prose-against-behavior class.
  test('the skip note states what skipping actually does when there are dependants to orphan', () => {
    const { workspace, offer, firstSend } = noCollisionScenario();
    const state = projected(workspace, { state: offer, send: firstSend });
    const row = rowOf(state, 'agent:wren');
    assert.doesNotMatch(row.blockedNote, /exactly as it is/,
      'skipping does not leave the workspace as it was when dependants come with it');
    for (const dependant of ['scout', 'quill']) {
      assert.ok(row.blockedNote.includes(dependant),
        `the note names ${dependant}, because a consequence nobody can see is not disclosed`);
    }
  });

  test('the skip note keeps its original promise when nothing would be orphaned', () => {
    // A blocked default carrying no dependants really does leave the
    // workspace untouched, so the honest sentence there is the original one.
    //
    // The colliding skill is load-bearing rather than incidental: with no
    // dependants there is no attach offer, so a collision is the only other
    // thing that opens the review, and without one this row cannot render at
    // all. That case, a default conflict alone on the plain confirm card, is
    // the residual limit recorded in packages-install-model.js.
    const workspace = makeTempDir('att-solo-ws-');
    const sourceRoot = makeTempDir('att-solo-src-');
    write(workspace, '.claude/agents/cos.md', LEADER);
    write(workspace, '.claude/skills/notes/SKILL.md', 'existing skill');
    write(sourceRoot, '.claude/agents/wren.md', WREN);
    write(sourceRoot, '.claude/skills/notes/SKILL.md', 'incoming skill');
    sourceRoots.set(workspace, sourceRoot);
    const planMsg = realReply(workspace, 'plan_package_import', {
      sourcePath: sourceRoot, source: { id: sourceRoot, reference: null },
    });
    const out = model.reply(model.submit(model.initial(), sourceRoot).state, planMsg);
    const state = projected(workspace, out);
    const row = rowOf(state, 'agent:wren');
    assert.match(row.blockedNote, /exactly as it is/,
      'with nothing to orphan the original sentence is true and stays');
    assert.strictEqual(row.attachAction, undefined,
      'there is no separate attach control anywhere any more');
    assert.ok(row.blockedAction,
      'and skipping is offered, because here it really does leave the workspace alone');
  });

  // Skipping a blocked leader whose specialists are still arriving is the one
  // action of the three that cannot end anywhere correct. Those specialists
  // name that leader in their own frontmatter, so with it absent the name
  // resolves to nothing and they attach at the top level, contradicting the
  // package's own design and leaving a dangling reportsTo that would silently
  // re-parent them if an agent of that name ever appeared. Adopt and attach
  // both end somewhere coherent. This one does not, so it is withdrawn rather
  // than offered with a warning: a choice whose only outcome is wrong is not
  // a choice, and the warning was already proven insufficient in use.
  test('skipping a blocked leader carries its specialists rather than stranding them', () => {
    const { workspace, offer, firstSend } = noCollisionScenario();
    const state = projected(workspace, { state: offer, send: firstSend });
    const row = rowOf(state, 'agent:wren');
    assert.strictEqual(row.blockedAction.decision, 'attach',
      'the skip control carries the re-point while specialists are still arriving');
    assert.match(row.blockedAction.label, /team reports to Cos/,
      'and the label says where they go, because this control reaches past its own row');
  });

  test('skip becomes the ordinary skip once nothing would be carried', () => {
    // Skip the dependants themselves and the leader becomes safe to skip: the
    // package contributes nothing, which is coherent and a legitimate thing to
    // want. So the offer follows the decisions rather than being fixed when
    // the plan was built.
    const { workspace, offer, firstSend } = noCollisionScenario();
    let state = projected(workspace, { state: offer, send: firstSend });
    for (const dependant of ['agent:scout', 'agent:quill']) {
      // Changing a decision invalidates the projection and re-asks the one
      // evaluator on the server, so the row's blocked fields are absent until
      // that reply lands. Re-project rather than reading the gap.
      const next = model.setDecision(state, dependant, 'skip');
      state = next.send ? projected(workspace, next) : (next.state || next);
    }
    const row = rowOf(state, 'agent:wren');
    assert.deepStrictEqual(row.blockedAction, { label: 'Skip this item', decision: 'skip' },
      'with nobody left to carry, skipping the leader is the ordinary skip again');
  });
});
