'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { discoverPackage, buildPlan } = require('../../lib/packages/import-plan.js');
const { snapshotCurrent, digestFile, digestDirectory, withProvenance } = require('../../lib/packages/import-apply.js');
const { evaluateImport } = require('../../lib/packages/import-evaluate.js');
const { makeTempDir } = require('../helpers/workspace.js');

const SOURCE = { id: 'github.com/example/pack', reference: 'v1.0.0' };

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

// Decisions turn a plan into the approval object the evaluator accepts. A
// skip approves the reviewed pre-state itself, so its approved digest and
// default state collapse onto the planned ones.
function decide(plan, decisions) {
  return {
    schema: plan.schema,
    source: plan.source,
    manifest: plan.manifest,
    items: plan.items.map((item) => {
      const decision = decisions[item.id];
      const skip = decision === 'skip';
      return {
        ...item,
        decision,
        approvedDigest: skip ? item.plannedDigest : item.approvedDigest,
        agent: item.agent === null ? null : {
          plannedDefault: item.agent.plannedDefault,
          approvedDefault: skip ? item.agent.plannedDefault : item.agent.approvedDefault,
        },
      };
    }),
  };
}

const AGENT_TEXT = '---\nname: writer\n---\n\nWrite things.\n';
const DEFAULT_AGENT = '---\nname: lead\norder: 0\n---\n\nLead.\n';

function sourceFixture() {
  const sourceRoot = makeTempDir('plan-src-');
  write(sourceRoot, '.claude/agents/scribe.md', AGENT_TEXT);
  write(sourceRoot, '.claude/agents/lead.md', DEFAULT_AGENT);
  write(sourceRoot, '.claude/skills/writer/SKILL.md', 'new skill');
  write(sourceRoot, '.claude/skills/writer/refs/a.md', 'ref');
  write(sourceRoot, '.claude/skills/parked/SKILL.md', 'parked v2');
  return sourceRoot;
}

function workspaceFixture() {
  const workspace = makeTempDir('plan-ws-');
  write(workspace, 'notes/keep.md', 'foreign');
  write(workspace, '.claude/skills/writer/SKILL.md', 'old skill');
  write(workspace, '.claude/skills/parked/SKILL.md', 'parked');
  return workspace;
}

describe('discoverPackage refuses what it cannot honestly offer', () => {
  // [name, build(sourceRoot), message]
  const REFUSED = [
    ['a missing source root', () => null, /does not exist/],
    ['a source root that is a file', (root) => write(root, 'flat', 'x'), /must be a directory/],
    ['a non-slug agent file name', (root) => write(root, '.claude/agents/Not A Slug.md', AGENT_TEXT), /not a canonical agent file name/],
    ['an agent entry that is a directory', (root) => fs.mkdirSync(path.join(root, '.claude/agents/dir.md'), { recursive: true }), /not a regular file/],
    ['an agent that is a symlink', (root) => {
      write(root, 'real.md', AGENT_TEXT);
      fs.mkdirSync(path.join(root, '.claude/agents'), { recursive: true });
      fs.symlinkSync(path.join(root, 'real.md'), path.join(root, '.claude/agents/link.md'));
    }, /is a symlink/],
    ['a non-slug skill directory name', (root) => write(root, '.claude/skills/Bad Name/SKILL.md', 'x'), /not a canonical skill name/],
    ['a skill entry that is a file', (root) => write(root, '.claude/skills/flat', 'x'), /not a directory/],
    ['an empty package', (root) => fs.mkdirSync(path.join(root, '.claude'), { recursive: true }), /no agents and no skills/],
  ];

  for (const [name, build, message] of REFUSED) {
    test(`refuses ${name} by name, touching nothing`, () => {
      const root = makeTempDir('plan-src-');
      const target = build(root);
      const probe = name === 'a missing source root' ? path.join(root, 'absent')
        : name === 'a source root that is a file' ? target : root;
      const before = tree(root);
      assert.throws(() => discoverPackage(probe), message);
      assert.deepStrictEqual(tree(root), before);
    });
  }
});

describe('the manifest is deterministic', () => {
  test('identical source trees built in different orders produce identical, id-sorted manifests', () => {
    const a = makeTempDir('plan-src-a-');
    write(a, '.claude/skills/zeta/SKILL.md', 'z');
    write(a, '.claude/agents/omega.md', AGENT_TEXT);
    write(a, '.claude/agents/alpha.md', AGENT_TEXT);
    const b = makeTempDir('plan-src-b-');
    write(b, '.claude/agents/alpha.md', AGENT_TEXT);
    write(b, '.claude/skills/zeta/SKILL.md', 'z');
    write(b, '.claude/agents/omega.md', AGENT_TEXT);
    const first = discoverPackage(a);
    assert.deepStrictEqual(first, discoverPackage(b));
    assert.deepStrictEqual(first.map((e) => e.id), ['agent:alpha', 'agent:omega', 'skill:zeta']);
  });

  test('source digests are the apply adapter\'s own', () => {
    const sourceRoot = sourceFixture();
    const byId = new Map(discoverPackage(sourceRoot).map((e) => [e.id, e.sourceDigest]));
    assert.strictEqual(byId.get('agent:scribe'), digestFile(fs.readFileSync(path.join(sourceRoot, '.claude/agents/scribe.md'))));
    assert.strictEqual(byId.get('skill:writer'), digestDirectory(path.join(sourceRoot, '.claude/skills/writer')));
  });
});

describe('buildPlan', () => {
  test('records collision truth per destination and writes nothing anywhere', () => {
    const workspace = workspaceFixture();
    const sourceRoot = sourceFixture();
    const wsBefore = tree(workspace);
    const srcBefore = tree(sourceRoot);
    const plan = buildPlan(workspace, sourceRoot, SOURCE);
    const byId = new Map(plan.items.map((i) => [i.id, i]));
    assert.strictEqual(byId.get('agent:scribe').collision, false);
    assert.strictEqual(byId.get('agent:scribe').plannedDigest, 'absent');
    assert.strictEqual(byId.get('skill:writer').collision, true);
    assert.strictEqual(byId.get('skill:writer').plannedDigest, digestDirectory(path.join(workspace, '.claude/skills/writer')));
    assert.strictEqual(byId.get('skill:parked').collision, true);
    assert.deepStrictEqual(tree(workspace), wsBefore);
    assert.deepStrictEqual(tree(sourceRoot), srcBefore);
  });

  test('approved digests come from the provenance-transformed bytes, pinned byte-for-byte', () => {
    const workspace = workspaceFixture();
    const sourceRoot = sourceFixture();
    const plan = buildPlan(workspace, sourceRoot, SOURCE);
    const byId = new Map(plan.items.map((i) => [i.id, i]));
    const pinned = '---\nname: writer\nsource: github.com/example/pack\n---\n\nWrite things.\n';
    assert.strictEqual(byId.get('agent:scribe').approvedDigest, digestFile(Buffer.from(pinned)));
    assert.strictEqual(byId.get('agent:scribe').approvedDigest,
      digestFile(Buffer.from(withProvenance(AGENT_TEXT, SOURCE.id))));
    assert.strictEqual(byId.get('skill:writer').approvedDigest, byId.get('skill:writer').sourceDigest);
  });

  test('default membership is read with the product rule on both sides of the plan', () => {
    const workspace = workspaceFixture();
    write(workspace, '.claude/agents/lead.md', DEFAULT_AGENT);
    const sourceRoot = sourceFixture();
    const plan = buildPlan(workspace, sourceRoot, SOURCE);
    const lead = plan.items.find((i) => i.id === 'agent:lead');
    assert.strictEqual(lead.collision, true);
    assert.strictEqual(lead.agent.plannedDefault, true);
    assert.strictEqual(lead.agent.approvedDefault, true);
    const scribe = plan.items.find((i) => i.id === 'agent:scribe');
    assert.deepStrictEqual(scribe.agent, { plannedDefault: false, approvedDefault: false });
  });

  test('a decided plan survives JSON and the real evaluator end to end', () => {
    const workspace = workspaceFixture();
    const sourceRoot = sourceFixture();
    const plan = buildPlan(workspace, sourceRoot, SOURCE);
    const approval = JSON.parse(JSON.stringify(decide(plan, {
      'agent:scribe': 'add',
      'agent:lead': 'add',
      'skill:writer': 'overwrite',
      'skill:parked': 'skip',
    })));
    const result = evaluateImport(approval, snapshotCurrent(workspace, sourceRoot, approval));
    assert.strictEqual(result.status, 'ready');
    assert.deepStrictEqual(result.writes.map((w) => w.id), ['agent:lead', 'agent:scribe', 'skill:writer']);
    assert.deepStrictEqual(result.skipped.map((w) => w.id), ['skill:parked']);
    assert.deepStrictEqual(result.blocked, []);
    assert.deepStrictEqual(result.stale, []);
  });

  test('refuses a source identity the caller did not really supply', () => {
    const workspace = workspaceFixture();
    const sourceRoot = sourceFixture();
    assert.throws(() => buildPlan(workspace, sourceRoot, { id: '', reference: null }), /non-empty id/);
    assert.throws(() => buildPlan(workspace, sourceRoot, { id: 'x', reference: '' }), /non-empty string or null/);
    const plan = buildPlan(workspace, sourceRoot, { id: 'x', reference: null });
    assert.deepStrictEqual(plan.source, { id: 'x', reference: null });
  });
});
