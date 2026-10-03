'use strict';
// The blocked default row's third way out. A package carrying its own
// orchestrator, imported where a leader already exists, could be skipped or
// attached; attach FLATTENS, discarding the package's leader and handing its
// specialists to an agent with no instructions for them. Adopt keeps the
// package author's design: the package's leader becomes a specialist
// reporting to the existing leader, and its own specialists keep reporting
// to it. One file is transformed; the dependants are not touched.
//
// Evidence held here, in the order the constraints demand it:
// - the RENDERED blocked row carries three actions, adopt first;
// - the scenario carries ZERO collisions, asserted, because the shipping
//   case (a package of all-new agents) has none and a collision would be the
//   only reason the review opened;
// - the plan-side approved digest covers the exact composed bytes the writer
//   produces (withAdoption, then withProvenance), so the existing digest
//   check at write time covers the transform instead of being bypassed;
// - the RENDERED org chart shows three levels by geometry: Bea and Cleo
//   below Cos, Cos below Atlas, drawn by the product's own renderOrgChart;
// - the adopt copy names the specific agents and says the adopted agent's
//   own instructions may still describe it as the workspace's lead.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const model = require('../../public/packages-install-model.js');
const settings = require('../../public/views/settings.js');
const { decide } = require('../../lib/packages/import-plan.js');
const {
  applyImport, snapshotCurrent, digestFile, withAdoption, withProvenance,
} = require('../../lib/packages/import-apply.js');
const { evaluateImport } = require('../../lib/packages/import-evaluate.js');
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

// Every wire shape below comes from the REAL handlers through the real
// dispatch table, the same technique the attach suite uses, so a renamed
// field or status on the wire turns this red rather than a copy of the wire
// quietly keeping up appearances.
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

const ATLAS = '---\nname: atlas\ndisplayName: Atlas\nrole: Chief\ntype: orchestrator\norder: 0\n---\n\nChief of staff.\n';
const COS = '---\nname: cos\ntype: orchestrator\norder: 0\n---\n\nI come to you first.\n';
const BEA = '---\nname: bea\ntype: specialist\norder: 1\nreportsTo: cos\n---\n\nBea.\n';
const CLEO = '---\nname: cleo\ntype: specialist\norder: 2\nreportsTo: cos\n---\n\nCleo.\n';

// The shipping case: a workspace led by Atlas, and a package of ALL-NEW
// agents led by its own orchestrator with two dependants naming it. Nothing
// collides; the attach offer alone opens the review.
function adoptScenario() {
  const workspace = makeTempDir('adp-ws-');
  const sourceRoot = makeTempDir('adp-src-');
  write(workspace, '.claude/agents/atlas.md', ATLAS);
  write(sourceRoot, '.claude/agents/cos.md', COS);
  write(sourceRoot, '.claude/agents/bea.md', BEA);
  write(sourceRoot, '.claude/agents/cleo.md', CLEO);
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

// The RENDERED org chart: the product's own renderOrgChart over a real
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

const NOTE = 'cos joins as a specialist reporting to Atlas, and bea and cleo keep '
  + "reporting to cos. cos's own instructions may still describe it as the workspace's lead.";

describe('the blocked default row offers adopt, ahead of attach', () => {
  test('the rendered blocked row carries exactly two controls: adopt, then skip-with-its-team', () => {
    const { workspace, offer, firstSend } = adoptScenario();
    assert.strictEqual(offer.collisions.length, 0,
      'this scenario must carry no collisions: the shipping case is a package of all-new agents');
    const first = projected(workspace, { state: offer, send: firstSend });

    const row = rowOf(first, 'agent:cos');
    assert.strictEqual(row.rowClass, 'blocked');
    assert.deepStrictEqual(row.adoptAction,
      { label: 'Add as a specialist under Atlas', decision: 'adopt' },
      'the third way out keeps the package author\'s design');
    // Two ways out, not three. Skipping cos carries bea and cleo to
    // Atlas rather than orphaning them, so the skip control IS the old
    // attach control and says what it does.
    assert.deepStrictEqual(row.blockedAction, {
      label: 'Skip; team reports to Atlas',
      decision: 'attach',
    }, 'skipping the leader re-points its specialists rather than stranding them');
    assert.strictEqual(row.attachAction, undefined,
      'and there is no separate attach control, because that is what skip now is');

    const html = renderRow(first, 'agent:cos');
    const at = (needle) => {
      const index = html.indexOf(needle);
      assert.ok(index !== -1, `the blocked row renders ${needle}`);
      return index;
    };
    const adopt = at('data-decision="adopt"');
    const skip = at('data-decision="attach"');
    assert.ok(adopt < skip,
      `adopt renders ahead of the skip control (got offsets ${adopt}, ${skip})`);
    // Exactly two controls. A third reading a bare "skip" would offer the
    // one outcome that contradicts the package, which is what the warning
    // alone failed to prevent.
    assert.strictEqual(html.indexOf('data-decision="skip"'), -1,
      'the plain skip decision is not offered while specialists would be left behind');
    assert.strictEqual(html.split('packages-blocked-resolve').length - 1, 2,
      'two controls on the blocked row, no more');
    assert.match(html, /data-decision="adopt"[^>]*>Add as a specialist under Atlas</,
      'the adopt control carries its own label');
    assert.match(html, /data-decision="adopt"[^>]*\s*onclick="packagesSetDecision\(this\.closest\('\.packages-item-row'\)\.dataset\.item, this\.dataset\.decision\)"/,
      'the adopt control goes through the same handler as every other decision');
  });

  test('choosing adopt clears the conflict, writes all three agents, and the chosen row states the consequence', () => {
    const { workspace, offer, firstSend } = adoptScenario();
    const first = projected(workspace, { state: offer, send: firstSend });

    const chosen = model.setDecision(first, 'agent:cos', 'adopt');
    assert.strictEqual(chosen.state.decisions['agent:cos'], 'adopt');
    assert.strictEqual(chosen.send.type, 'evaluate_package_decisions');
    const evalMsg = realReply(workspace, 'evaluate_package_decisions', chosen.send);
    assert.deepStrictEqual(evalMsg.blocked, []);
    assert.deepStrictEqual(evalMsg.skipped, []);
    assert.deepStrictEqual(evalMsg.writes.map((s) => s.id), ['agent:bea', 'agent:cleo', 'agent:cos']);

    // The chosen row says exactly what it will do, naming the specific
    // agents, and says the adopted agent's own instructions may still claim
    // primacy: rewriting an author's prose is out of bounds, so the copy has
    // to own the mismatch instead.
    const settled = model.reply(chosen.state, evalMsg).state;
    const chosenRow = rowOf(settled, 'agent:cos');
    assert.strictEqual(chosenRow.rowClass, 'willAdd');
    assert.strictEqual(chosenRow.adoptNote, NOTE);
    assert.match(renderRow(settled, 'agent:cos'), /packages-adopt-note/,
      'the chosen state reaches the rendered row');

    // Confirm applies through the real handler; the adopted leader lands
    // transformed, and the dependants land untouched but for provenance.
    const confirmed = model.confirm(settled);
    const applyMsg = realReply(workspace, 'apply_package_import', confirmed.send);
    const done = model.reply(confirmed.state, applyMsg).state;
    assert.strictEqual(done.phase, 'done');
    assert.deepStrictEqual(done.written.map((w) => w.id), ['agent:bea', 'agent:cleo', 'agent:cos']);

    const cos = fs.readFileSync(path.join(workspace, '.claude/agents/cos.md'), 'utf8');
    assert.ok(cos.includes('\ntype: specialist\n'), `the adopted leader is a specialist; got:\n${cos}`);
    assert.ok(cos.includes('\norder: 1\n'), 'the adopted leader is no longer order 0');
    assert.ok(cos.includes('\nreportsTo: atlas\n'), 'the adopted leader reports to the existing leader');
    assert.ok(cos.includes('I come to you first.'), 'the author\'s prose is untouched');
    assert.strictEqual(discovery.agentIsDefault(discovery.parseAgentFrontmatter(cos)), false,
      'the product\'s own reading of the written bytes is non-default');
    for (const slug of ['bea', 'cleo']) {
      const written = fs.readFileSync(path.join(workspace, `.claude/agents/${slug}.md`), 'utf8');
      assert.ok(written.includes('\nreportsTo: cos\n'),
        `${slug} still reports to the package's own leader; got:\n${written}`);
    }
  });

  test('adopt is refused on an item that carries no adopt offer', () => {
    const { workspace, offer, firstSend } = adoptScenario();
    const first = projected(workspace, { state: offer, send: firstSend });
    const refused = model.setDecision(first, 'agent:bea', 'adopt');
    assert.strictEqual(refused.state, first, 'a dependant has no adopt decision of its own');
    assert.strictEqual(refused.send, undefined);
  });
});

describe('the digest path covers the adoption transform', () => {
  test('the plan-side approved digest is derived from the exact composed bytes apply writes', () => {
    const { workspace, sourceRoot, planMsg } = adoptScenario();
    const cos = planMsg.plan.items.filter((i) => i.id === 'agent:cos')[0];
    assert.ok(cos.agent.adopt, 'the blocked default carries its adopted variant as a plan fact');
    assert.strictEqual(cos.agent.adopt.to, 'atlas');
    assert.strictEqual(cos.agent.adopt.leader, 'Atlas');
    // The composition order is the writer's own: adoption first, then
    // provenance, digested over exactly those bytes.
    const composed = withProvenance(withAdoption(COS, 'atlas'), sourceRoot);
    assert.strictEqual(cos.agent.adopt.approvedDigest, digestFile(Buffer.from(composed, 'utf8')));

    const approval = decide(planMsg.plan, {
      'agent:cos': 'adopt', 'agent:bea': 'add', 'agent:cleo': 'add',
    });
    const decided = approval.items.filter((i) => i.id === 'agent:cos')[0];
    assert.strictEqual(decided.decision, 'add', 'an adopted leader is written, never skipped');
    assert.strictEqual(decided.approvedDigest, cos.agent.adopt.approvedDigest,
      'the decision contract selects the adopted digest, once, for both sides');
    assert.strictEqual(decided.agent.adoptUnder, 'atlas');
    assert.strictEqual(decided.agent.approvedDefault, false,
      'the adopted bytes read as non-default, and the approval says so');

    const result = applyImport(workspace, sourceRoot, approval, { receipt: {} });
    assert.strictEqual(result.status, 'ready');
    const writtenDigest = result.writes.filter((w) => w.id === 'agent:cos')[0].approvedDigest;
    assert.strictEqual(writtenDigest, cos.agent.adopt.approvedDigest);
  });

  test('an adoptUnder that does not hash to the approved digest is refused at write time', () => {
    const { workspace, sourceRoot, planMsg } = adoptScenario();
    const approval = decide(planMsg.plan, {
      'agent:cos': 'adopt', 'agent:bea': 'add', 'agent:cleo': 'add',
    });
    for (const item of approval.items) {
      if (item.id === 'agent:cos') item.agent.adoptUnder = 'somebody-else';
    }
    assert.throws(() => applyImport(workspace, sourceRoot, approval, { receipt: {} }),
      /bytes for agent:cos do not match the approved digest; refusing to write/);
    assert.ok(!fs.existsSync(path.join(workspace, '.claude/agents/cos.md')),
      'nothing lands when the transform and the digest disagree');
  });

  test('the evaluator refuses an adoptUnder that is not a single-line string, or that rides beside attachTo', () => {
    const { workspace, sourceRoot, planMsg } = adoptScenario();
    const decisions = { 'agent:cos': 'adopt', 'agent:bea': 'add', 'agent:cleo': 'add' };
    for (const bad of ['nobody\norder: 0', '', 42]) {
      const approval = JSON.parse(JSON.stringify(decide(planMsg.plan, decisions)));
      for (const item of approval.items) {
        if (item.id === 'agent:cos') item.agent.adoptUnder = bad;
      }
      assert.throws(() => evaluateImport(approval, snapshotCurrent(workspace, sourceRoot, approval)),
        /adoptUnder/, `an adoptUnder of ${JSON.stringify(bad)} cannot reach the writer`);
    }
    const approval = JSON.parse(JSON.stringify(decide(planMsg.plan, decisions)));
    for (const item of approval.items) {
      if (item.id === 'agent:cos') item.agent.attachTo = 'atlas';
    }
    assert.throws(() => evaluateImport(approval, snapshotCurrent(workspace, sourceRoot, approval)),
      /attachTo|adoptUnder/, 'one item cannot carry two competing re-parent transforms');
  });

  test('withAdoption rewrites exactly the three frontmatter facts and refuses what it cannot make non-default', () => {
    assert.strictEqual(
      withAdoption('---\nname: cos\ntype: orchestrator\norder: 0\n---\n\nBody.\n', 'atlas'),
      '---\nname: cos\ntype: specialist\norder: 1\nreportsTo: atlas\n---\n\nBody.\n',
      'type, order and reportsTo change; nothing else does');
    assert.strictEqual(
      withAdoption('---\r\nname: cos\r\ntype: orchestrator\r\norder: 0\r\n---\r\n\r\nBody.\r\n', 'atlas'),
      '---\r\nname: cos\r\ntype: specialist\r\norder: 1\r\nreportsTo: atlas\r\n---\r\n\r\nBody.\r\n',
      'the file\'s own line endings are kept');
    assert.strictEqual(
      withAdoption('\ufeff---\nname: cos\norder: 0\nreportsTo: nobody\n---\n\nBody.\n', 'atlas'),
      '---\nname: cos\norder: 1\nreportsTo: atlas\n---\n\nBody.\n',
      'a BOM is dropped, an existing reportsTo is rewritten in place, and an absent type stays absent');
    assert.strictEqual(
      withAdoption('---\nname: cos\nisDefault: true\n---\n\nBody.\n', 'atlas'),
      '---\nname: cos\nisDefault: false\nreportsTo: atlas\n---\n\nBody.\n',
      'a default declared through isDefault is cleared through the same key');
    assert.throws(() => withAdoption('no frontmatter at all\n', 'atlas'), /frontmatter/);
    assert.throws(() => withAdoption('---\nname: cos\norder: 0\n', 'atlas'), /never closes/);
    assert.throws(() => withAdoption('---\norder: 0\norder: 0\n---\n\nBody.\n', 'atlas'),
      /still reads as a default/,
      'bytes the transform cannot make non-default never reach a digest');
  });
});

describe('the rendered chart shows three levels: the package structure intact under the existing leader', () => {
  test('bea and cleo sit below cos, and cos sits below atlas, by geometry', () => {
    const { workspace, sourceRoot, planMsg } = adoptScenario();
    const approval = decide(planMsg.plan, {
      'agent:cos': 'adopt', 'agent:bea': 'add', 'agent:cleo': 'add',
    });
    const result = applyImport(workspace, sourceRoot, approval, { receipt: {} });
    assert.strictEqual(result.status, 'ready');

    const cards = renderedChart(rosterOf(workspace));
    // The workspace leader's discovery id is `default`; the package's agents
    // keep their slugs.
    assert.ok(cards.default && cards.cos && cards.bea && cards.cleo,
      `all four cards are rendered; got: ${Object.keys(cards).join(', ')}`);
    assert.ok(cards.cos.top > cards.default.top,
      `cos hangs UNDER atlas (cos top ${cards.cos.top}, atlas top ${cards.default.top})`);
    assert.ok(cards.bea.top > cards.cos.top,
      `bea hangs UNDER cos (bea top ${cards.bea.top}, cos top ${cards.cos.top})`);
    assert.ok(cards.cleo.top > cards.cos.top,
      `cleo hangs UNDER cos (cleo top ${cards.cleo.top}, cos top ${cards.cos.top})`);
    assert.strictEqual(cards.bea.top, cards.cleo.top, 'the two specialists share one row');
    assert.ok(new Set([cards.default.top, cards.cos.top, cards.bea.top]).size === 3,
      'three distinct levels render, which is the package author\'s design intact');
  });
});
