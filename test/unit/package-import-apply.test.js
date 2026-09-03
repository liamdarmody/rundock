'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  applyImport,
  snapshotCurrent,
  digestFile,
  digestDirectory,
  withProvenance,
} = require('../../lib/packages/import-apply.js');
const { journalPath, writeAsUnit, IMPORT_SUBDIR } = require('../../lib/workspace/atomic-write.js');
const { readNormalisedFile, parseAgentFrontmatter, agentIsDefault } = require('../../lib/agents/discovery.js');
const { makeTempDir } = require('../helpers/workspace.js');

const SOURCE_ID = 'github.com/example/pack';

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

// The complete workspace as one comparable value.
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

function digestPath(absolute) {
  if (!fs.existsSync(absolute)) return 'absent';
  return fs.statSync(absolute).isDirectory()
    ? digestDirectory(absolute)
    : digestFile(fs.readFileSync(absolute));
}

// Normalise the way readNormalisedFile does, then apply the product's own
// default rule, so this helper cannot encode a competing definition.
function declaresDefault(text) {
  return agentIsDefault(parseAgentFrontmatter(text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n')));
}

// Build a valid approval from a source tree and the current workspace with
// the module's own exported helpers, as the future plan module will.
function buildApproval(workspace, sourceRoot, decisions) {
  const entries = [];
  for (const [id, decision] of Object.entries(decisions)) {
    const [kind, slug] = id.split(':');
    const destination = kind === 'agent' ? `.claude/agents/${slug}.md` : `.claude/skills/${slug}`;
    const sourceAbsolute = path.join(sourceRoot, destination);
    const sourceDigest = digestPath(sourceAbsolute);
    const destAbsolute = path.join(workspace, destination);
    const plannedDigest = digestPath(destAbsolute);
    const collision = plannedDigest !== 'absent';
    let approvedDigest;
    let approvedText = null;
    if (decision === 'skip') {
      approvedDigest = plannedDigest;
    } else if (kind === 'agent') {
      approvedText = withProvenance(fs.readFileSync(sourceAbsolute, 'utf8'), SOURCE_ID);
      approvedDigest = digestFile(Buffer.from(approvedText, 'utf8'));
    } else {
      approvedDigest = sourceDigest;
    }
    let agent = null;
    if (kind === 'agent') {
      const plannedDefault = collision ? declaresDefault(fs.readFileSync(destAbsolute, 'utf8')) : false;
      const approvedDefault = decision === 'skip' ? plannedDefault : declaresDefault(approvedText);
      agent = { plannedDefault, approvedDefault };
    }
    entries.push({ id, kind, slug, destination, collision, decision, plannedDigest, approvedDigest, sourceDigest, agent });
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    schema: 'rundock.package-import-approval/v1',
    source: { id: SOURCE_ID, reference: 'v1.0.0' },
    manifest: entries.map(({ id, kind, slug, sourceDigest }) => ({ id, kind, slug, sourceDigest })),
    items: entries,
  };
}

// A minimal single-item approval whose approvedDigest is supplied raw, for
// cases where deriving it through the transformation is the thing under test.
function buildApprovalWithRawApproved(workspace, sourceRoot, id, approvedDigest) {
  const [kind, slug] = id.split(':');
  const destination = `.claude/agents/${slug}.md`;
  const sourceDigest = digestPath(path.join(sourceRoot, destination));
  const item = {
    id, kind, slug, destination, collision: false, decision: 'add',
    plannedDigest: 'absent', approvedDigest, sourceDigest,
    agent: { plannedDefault: false, approvedDefault: false },
  };
  return {
    schema: 'rundock.package-import-approval/v1',
    source: { id: SOURCE_ID, reference: 'v1.0.0' },
    manifest: [{ id, kind, slug, sourceDigest }],
    items: [item],
  };
}

const AGENT_TEXT = '---\nname: writer\n---\n\nWrite things.\n';
const DEFAULT_AGENT_A = '---\nname: alpha\norder: 0\n---\n\nLead.\n';
const DEFAULT_AGENT_B = '---\nname: beta\norder: 0\n---\n\nAlso lead.\n';

// An agent to add, a skill to overwrite, a skill to skip, a foreign file.
function fixture() {
  const workspace = makeTempDir('import-apply-ws-');
  const sourceRoot = makeTempDir('import-apply-src-');
  write(workspace, 'notes/keep.md', 'foreign');
  write(workspace, '.claude/skills/writer/SKILL.md', 'old skill');
  write(workspace, '.claude/skills/writer/stale.md', 'stale file');
  write(workspace, '.claude/skills/parked/SKILL.md', 'parked');
  write(sourceRoot, '.claude/agents/scribe.md', AGENT_TEXT);
  write(sourceRoot, '.claude/skills/writer/SKILL.md', 'new skill');
  write(sourceRoot, '.claude/skills/writer/refs/a.md', 'ref');
  write(sourceRoot, '.claude/skills/parked/SKILL.md', 'parked v2');
  const approval = buildApproval(workspace, sourceRoot, {
    'agent:scribe': 'add',
    'skill:writer': 'overwrite',
    'skill:parked': 'skip',
  });
  return { workspace, sourceRoot, approval, before: tree(workspace) };
}

describe('canonical digests', () => {
  test('a file digest covers exact bytes and never collides with a directory digest', () => {
    const root = makeTempDir('digest-');
    write(root, 'dir/a.md', 'x');
    assert.notStrictEqual(digestFile(Buffer.from('x')), digestFile(Buffer.from('y')));
    assert.notStrictEqual(digestFile(Buffer.from('x')), digestDirectory(path.join(root, 'dir')));
  });

  test('a directory digest covers the relative path of every file, not only its bytes', () => {
    const a = makeTempDir('digest-a-');
    const b = makeTempDir('digest-b-');
    write(a, 'SKILL.md', 'same bytes');
    write(b, 'RENAMED.md', 'same bytes');
    assert.notStrictEqual(digestDirectory(a), digestDirectory(b));
  });

  test('a directory digest is identical for identical trees built in different orders', () => {
    const a = makeTempDir('digest-a-');
    const b = makeTempDir('digest-b-');
    write(a, 'one.md', '1'); write(a, 'sub/two.md', '2');
    write(b, 'sub/two.md', '2'); write(b, 'one.md', '1');
    assert.strictEqual(digestDirectory(a), digestDirectory(b));
  });

  test('a symlink inside a directory is refused, never followed', () => {
    const root = makeTempDir('digest-');
    write(root, 'dir/a.md', 'x');
    fs.symlinkSync(path.join(root, 'dir', 'a.md'), path.join(root, 'dir', 'link.md'));
    assert.throws(() => digestDirectory(path.join(root, 'dir')), /unsupported symlink/);
  });
});

describe('withProvenance', () => {
  test('inserts the source line inside existing frontmatter, pinned byte-for-byte', () => {
    assert.strictEqual(withProvenance('---\nname: writer\n---\n\nBody.\n', 'a/b'), '---\nname: writer\nsource: a/b\n---\n\nBody.\n');
    assert.strictEqual(withProvenance('---\nsource: kept/value\n---\n\nBody.\n', 'a/b'), '---\nsource: kept/value\n---\n\nBody.\n');
  });

  test('creates frontmatter when the agent has none, pinned byte-for-byte', () => {
    assert.strictEqual(withProvenance('Just a body.\n', 'a/b'), '---\nsource: a/b\n---\n\nJust a body.\n');
  });
});

describe('snapshotCurrent', () => {
  test('reports destination digests for file, directory and absent destinations', () => {
    const { workspace, sourceRoot, approval } = fixture();
    const current = snapshotCurrent(workspace, sourceRoot, approval);
    const byDest = new Map(current.destinations.map((d) => [d.destination, d.digest]));
    assert.strictEqual(byDest.get('.claude/agents/scribe.md'), 'absent');
    assert.strictEqual(byDest.get('.claude/skills/writer'), digestDirectory(path.join(workspace, '.claude/skills/writer')));
    assert.strictEqual(byDest.get('.claude/skills/parked'), digestDirectory(path.join(workspace, '.claude/skills/parked')));
  });

  test('omits missing sources so the evaluator can classify them as source-missing', () => {
    const { workspace, sourceRoot, approval } = fixture();
    fs.rmSync(path.join(sourceRoot, '.claude/agents/scribe.md'));
    const current = snapshotCurrent(workspace, sourceRoot, approval);
    assert.deepStrictEqual(current.sources.map((s) => s.id).sort(), ['skill:parked', 'skill:writer']);
  });

  test('reports every canonically named agent with its default membership, and only those', () => {
    const { workspace, sourceRoot, approval } = fixture();
    write(workspace, '.claude/agents/alpha.md', DEFAULT_AGENT_A);
    write(workspace, '.claude/agents/plain.md', AGENT_TEXT);
    write(workspace, '.claude/agents/Not A Slug.md', AGENT_TEXT);
    const current = snapshotCurrent(workspace, sourceRoot, approval);
    assert.deepStrictEqual(current.agents.map((a) => [a.destination, a.isDefault]), [
      ['.claude/agents/alpha.md', true],
      ['.claude/agents/plain.md', false],
    ]);
  });
});

describe('the snapshot refuses what it cannot represent', () => {
  test('every default declaration form discovery accepts is seen as a default', () => {
    const { workspace, sourceRoot, approval } = fixture();
    write(workspace, '.claude/agents/bybool.md', '---\nisDefault: true\n---\n\nA.\n');
    write(workspace, '.claude/agents/bystring.md', '---\nisDefault: "true"\n---\n\nB.\n');
    write(workspace, '.claude/agents/byorder.md', '---\norder: 0\n---\n\nC.\n');
    write(workspace, '.claude/agents/plain.md', AGENT_TEXT);
    const current = snapshotCurrent(workspace, sourceRoot, approval);
    assert.deepStrictEqual(current.agents.map((a) => [a.destination, a.isDefault]), [
      ['.claude/agents/bybool.md', true],
      ['.claude/agents/byorder.md', true],
      ['.claude/agents/bystring.md', true],
      ['.claude/agents/plain.md', false],
    ]);
  });

  test('a non-canonical default declared via isDefault refuses the import too', () => {
    const { workspace, sourceRoot, approval } = fixture();
    write(workspace, '.claude/agents/Not A Slug Two.md', '---\nisDefault: true\n---\n\nD.\n');
    const before = tree(workspace);
    assert.throws(() => applyImport(workspace, sourceRoot, approval), /outside canonical naming/);
    assert.deepStrictEqual(tree(workspace), before);
  });

  test('a destination that cannot be observed aborts rather than reading as absent', (t) => {
    if (process.getuid && process.getuid() === 0) { t.skip('root ignores modes'); return; }
    const { workspace, sourceRoot, approval, before } = fixture();
    const skills = path.join(workspace, '.claude', 'skills');
    fs.chmodSync(skills, 0o000);
    try {
      assert.throws(() => applyImport(workspace, sourceRoot, approval), /EACCES|EPERM/);
    } finally {
      fs.chmodSync(skills, 0o755);
    }
    assert.deepStrictEqual(tree(workspace), before);
  });

  test('a file standing where the agents directory belongs aborts the snapshot', () => {
    const { workspace, sourceRoot, approval, before } = fixture();
    write(workspace, '.claude/agents', 'not a directory');
    assert.throws(() => applyImport(workspace, sourceRoot, approval), /ENOTDIR/);
    assert.deepStrictEqual(tree(workspace), [...before, '.claude/agents:' + Buffer.from('not a directory').toString('base64')].sort());
  });

  test('a symlink at a canonical agent path aborts the snapshot and the apply', () => {
    const { workspace, sourceRoot, approval } = fixture();
    write(workspace, 'real.md', DEFAULT_AGENT_A);
    fs.mkdirSync(path.join(workspace, '.claude/agents'), { recursive: true });
    fs.symlinkSync(path.join(workspace, 'real.md'), path.join(workspace, '.claude/agents/lead.md'));
    const before = tree(workspace);
    assert.throws(() => snapshotCurrent(workspace, sourceRoot, approval), /unsupported filesystem entry type/);
    assert.throws(() => applyImport(workspace, sourceRoot, approval), /unsupported filesystem entry type/);
    assert.deepStrictEqual(tree(workspace), before);
  });

  test('a default agent outside canonical naming refuses the import rather than hiding the default', () => {
    const { workspace, sourceRoot, approval } = fixture();
    write(workspace, '.claude/agents/Not A Slug.md', DEFAULT_AGENT_B);
    const before = tree(workspace);
    assert.throws(() => applyImport(workspace, sourceRoot, approval), /outside canonical naming/);
    assert.deepStrictEqual(tree(workspace), before);
  });
});

describe('applyImport', () => {
  test('applies add, overwrite and skip as one transaction with verified bytes', () => {
    const { workspace, sourceRoot, approval } = fixture();
    const result = applyImport(workspace, sourceRoot, approval);
    assert.strictEqual(result.status, 'ready');
    assert.deepStrictEqual(result.writes.map((w) => w.id), ['agent:scribe', 'skill:writer']);
    assert.deepStrictEqual(result.skipped.map((w) => w.id), ['skill:parked']);
    assert.strictEqual(result.written.length, 2);
    // The added agent carries provenance; the skill tree is replaced exactly.
    assert.match(read(workspace, '.claude/agents/scribe.md'), /^source: github\.com\/example\/pack$/m);
    assert.strictEqual(read(workspace, '.claude/skills/writer/SKILL.md'), 'new skill');
    assert.strictEqual(read(workspace, '.claude/skills/writer/refs/a.md'), 'ref');
    assert.strictEqual(fs.existsSync(path.join(workspace, '.claude/skills/writer/stale.md')), false);
    assert.strictEqual(read(workspace, '.claude/skills/parked/SKILL.md'), 'parked');
    assert.strictEqual(read(workspace, 'notes/keep.md'), 'foreign');
    assert.strictEqual(fs.existsSync(journalPath(workspace)), false);
  });

  test('replaying the exact JSON approval performs zero destination writes', () => {
    const { workspace, sourceRoot, approval } = fixture();
    applyImport(workspace, sourceRoot, approval);
    const after = tree(workspace);
    const replay = applyImport(workspace, sourceRoot, JSON.parse(JSON.stringify(approval)));
    assert.strictEqual(replay.status, 'ready');
    assert.deepStrictEqual(replay.writes, []);
    assert.deepStrictEqual(replay.written, []);
    assert.deepStrictEqual(replay.unchanged.map((w) => w.id), ['agent:scribe', 'skill:writer']);
    assert.deepStrictEqual(tree(workspace), after);
  });

  test('an agent that already declares a source keeps it', () => {
    const workspace = makeTempDir('import-apply-ws-');
    const sourceRoot = makeTempDir('import-apply-src-');
    const text = '---\nname: scribe\nsource: somewhere/else\n---\n\nBody.\n';
    write(sourceRoot, '.claude/agents/scribe.md', text);
    const approval = buildApproval(workspace, sourceRoot, { 'agent:scribe': 'add' });
    applyImport(workspace, sourceRoot, approval);
    const written = read(workspace, '.claude/agents/scribe.md');
    assert.match(written, /^source: somewhere\/else$/m);
    assert.strictEqual(written.match(/^source:/gm).length, 1);
  });

  test('overwriting an agent that already carries a source lands exactly the approved bytes', () => {
    const workspace = makeTempDir('import-apply-ws-');
    const sourceRoot = makeTempDir('import-apply-src-');
    write(workspace, '.claude/agents/scribe.md', '---\nname: scribe\nsource: previous/place\n---\n\nOld body.\n');
    write(workspace, 'notes/keep.md', 'foreign');
    write(sourceRoot, '.claude/agents/scribe.md', AGENT_TEXT);
    const approval = buildApproval(workspace, sourceRoot, { 'agent:scribe': 'overwrite' });
    const approvedText = withProvenance(AGENT_TEXT, SOURCE_ID);
    applyImport(workspace, sourceRoot, approval);
    // Byte-for-byte the approved post-state: the prior source value is gone
    // because the approved bytes replaced the file, and apply logic itself
    // introduced nothing beyond them.
    assert.strictEqual(read(workspace, '.claude/agents/scribe.md'), approvedText);
    assert.strictEqual(read(workspace, '.claude/agents/scribe.md').match(/^source:/gm).length, 1);
    // The product's own frontmatter reader must see the value.
    const meta = parseAgentFrontmatter(readNormalisedFile(path.join(workspace, '.claude/agents/scribe.md')));
    assert.strictEqual(meta.source, SOURCE_ID);
    assert.strictEqual(read(workspace, 'notes/keep.md'), 'foreign');
  });

  test('a CRLF agent keeps its frontmatter, its keys and its own line endings', () => {
    const workspace = makeTempDir('import-apply-ws-');
    const sourceRoot = makeTempDir('import-apply-src-');
    write(sourceRoot, '.claude/agents/crlf.md', '---\r\nname: crlf\r\norder: 5\r\n---\r\n\r\nBody.\r\n');
    applyImport(workspace, sourceRoot, buildApproval(workspace, sourceRoot, { 'agent:crlf': 'add' }));
    assert.strictEqual(read(workspace, '.claude/agents/crlf.md'),
      '---\r\nname: crlf\r\norder: 5\r\nsource: github.com/example/pack\r\n---\r\n\r\nBody.\r\n');
    const meta = parseAgentFrontmatter(readNormalisedFile(path.join(workspace, '.claude/agents/crlf.md')));
    assert.strictEqual(meta.name, 'crlf');
    assert.strictEqual(meta.order, '5');
    assert.strictEqual(meta.source, SOURCE_ID);
  });

  test('a BOM-prefixed agent lands readable by the product parser, with one frontmatter block', () => {
    const workspace = makeTempDir('import-apply-ws-');
    const sourceRoot = makeTempDir('import-apply-src-');
    write(sourceRoot, '.claude/agents/bom.md', '\ufeff---\nname: bom\n---\n\nB.\n');
    applyImport(workspace, sourceRoot, buildApproval(workspace, sourceRoot, { 'agent:bom': 'add' }));
    assert.strictEqual(read(workspace, '.claude/agents/bom.md'), '---\nname: bom\nsource: github.com/example/pack\n---\n\nB.\n');
    const meta = parseAgentFrontmatter(readNormalisedFile(path.join(workspace, '.claude/agents/bom.md')));
    assert.strictEqual(meta.name, 'bom');
    assert.strictEqual(meta.source, SOURCE_ID);
  });

  test('frontmatter that opens but never closes is refused with nothing written', () => {
    const workspace = makeTempDir('import-apply-ws-');
    const sourceRoot = makeTempDir('import-apply-src-');
    const bad = write(sourceRoot, '.claude/agents/broken.md', '---\nname: broken\n');
    const approval = buildApprovalWithRawApproved(workspace, sourceRoot, 'agent:broken', digestFile(fs.readFileSync(bad)));
    const before = tree(workspace);
    assert.throws(() => applyImport(workspace, sourceRoot, approval), /never closes/);
    assert.deepStrictEqual(tree(workspace), before);
  });

  test('a decisions-blocked evaluation performs zero destination writes', () => {
    const workspace = makeTempDir('import-apply-ws-');
    const sourceRoot = makeTempDir('import-apply-src-');
    write(sourceRoot, '.claude/agents/alpha.md', DEFAULT_AGENT_A);
    write(sourceRoot, '.claude/agents/beta.md', DEFAULT_AGENT_B);
    const approval = buildApproval(workspace, sourceRoot, { 'agent:alpha': 'add', 'agent:beta': 'add' });
    const before = tree(workspace);
    const result = applyImport(workspace, sourceRoot, approval);
    assert.strictEqual(result.status, 'decisions-blocked');
    assert.deepStrictEqual(result.written, []);
    assert.deepStrictEqual(tree(workspace), before);
  });

  test('an evaluator validation error propagates with zero destination writes', () => {
    const { workspace, sourceRoot, approval, before } = fixture();
    approval.schema = 'rundock.package-import-approval/v0';
    assert.throws(() => applyImport(workspace, sourceRoot, approval), /Invalid package import approval\.schema/);
    assert.deepStrictEqual(tree(workspace), before);
  });

  test('bytes that do not hash to the approved digest are refused with nothing written', () => {
    const { workspace, sourceRoot, approval, before } = fixture();
    const item = approval.items.find((i) => i.id === 'agent:scribe');
    item.approvedDigest = digestFile(Buffer.from('something else'));
    item.agent.approvedDefault = false;
    assert.throws(() => applyImport(workspace, sourceRoot, approval), /do not match the approved digest/);
    assert.deepStrictEqual(tree(workspace), before);
  });

  test('a skill whose approved digest disagrees with its source is refused with nothing written', () => {
    const { workspace, sourceRoot, approval, before } = fixture();
    const item = approval.items.find((i) => i.id === 'skill:writer');
    item.approvedDigest = digestFile(Buffer.from('some other tree'));
    assert.throws(() => applyImport(workspace, sourceRoot, approval), /do not match the approved digest/);
    assert.deepStrictEqual(tree(workspace), before);
  });

  test('a stale destination aborts with zero writes', () => {
    const { workspace, sourceRoot, approval, before } = fixture();
    write(workspace, '.claude/skills/writer/SKILL.md', 'changed after approval');
    const result = applyImport(workspace, sourceRoot, approval);
    assert.strictEqual(result.status, 'stale');
    assert.deepStrictEqual(result.written, []);
    assert.deepStrictEqual(result.stale.map((s) => [s.id, s.reason]), [['skill:writer', 'destination-changed']]);
    const expected = before.map((line) => (line.startsWith('.claude/skills/writer/SKILL.md:')
      ? '.claude/skills/writer/SKILL.md:' + Buffer.from('changed after approval').toString('base64') : line));
    assert.deepStrictEqual(tree(workspace), expected.sort());
  });

  test('a default conflict blocks the conflicting agents while unrelated writes land', () => {
    const workspace = makeTempDir('import-apply-ws-');
    const sourceRoot = makeTempDir('import-apply-src-');
    write(sourceRoot, '.claude/agents/alpha.md', DEFAULT_AGENT_A);
    write(sourceRoot, '.claude/agents/beta.md', DEFAULT_AGENT_B);
    write(sourceRoot, '.claude/skills/writer/SKILL.md', 'skill');
    const approval = buildApproval(workspace, sourceRoot, {
      'agent:alpha': 'add', 'agent:beta': 'add', 'skill:writer': 'add',
    });
    const result = applyImport(workspace, sourceRoot, approval);
    assert.strictEqual(result.status, 'ready');
    assert.deepStrictEqual(result.blocked.map((b) => [b.id, b.reason]),
      [['agent:alpha', 'default-conflict'], ['agent:beta', 'default-conflict']]);
    assert.deepStrictEqual(result.written, [path.join(workspace, '.claude/skills/writer')]);
    assert.strictEqual(fs.existsSync(path.join(workspace, '.claude/agents')), false);
    assert.strictEqual(read(workspace, '.claude/skills/writer/SKILL.md'), 'skill');
  });

  test('a filesystem item absent from the approval never enters the result or the writes', () => {
    const { workspace, sourceRoot, approval } = fixture();
    write(sourceRoot, '.claude/skills/uninvited/SKILL.md', 'not approved');
    const result = applyImport(workspace, sourceRoot, approval);
    const ids = ['writes', 'unchanged', 'skipped', 'blocked', 'stale']
      .flatMap((key) => result[key].map((o) => o.id));
    assert.strictEqual(ids.includes('skill:uninvited'), false);
    assert.strictEqual(fs.existsSync(path.join(workspace, '.claude/skills/uninvited')), false);
  });
});

// Run the real primitive over a directory destination on a scratch tree and
// read its journal off disk at the first commit boundary.
function captureRealCommittingJournal() {
  const scratch = makeTempDir('journal-capture-');
  write(scratch, '.claude/skills/parked/SKILL.md', 'parked');
  let captured = null;
  try {
    writeAsUnit(scratch, [], {
      replaceDirs: [{ path: path.join(scratch, '.claude/skills/parked'), files: [{ rel: 'SKILL.md', content: 'v2' }] }],
      afterStep: (step) => {
        if (step.phase === 'commit' && step.action === 'remove') {
          captured = JSON.parse(fs.readFileSync(journalPath(scratch), 'utf8'));
          throw new Error('captured');
        }
      },
    });
  } catch { /* the abort is the point; the primitive rolls the scratch back */ }
  assert.ok(captured, 'no committing journal was captured');
  return captured;
}

describe('recovery comes before everything', () => {
  test('an interrupted prior transaction is recovered before the snapshot', () => {
    const { workspace, sourceRoot, approval } = fixture();
    // A genuinely half-committed prior transaction over the skipped skill:
    // the destination holds replaced bytes, and the pre-transaction bytes the
    // approval was planned against live only in the journal's backup. The
    // snapshot can therefore match the approval ONLY if recovery ran first;
    // run after the snapshot, this same apply reports the skill as stale.
    write(workspace, '.claude/skills/parked/SKILL.md', 'half-committed bytes');
    write(workspace, path.join(IMPORT_SUBDIR, 'run', 'backup', '0', 'SKILL.md'), 'parked');
    const planted = {
      version: 1,
      runId: 'stale',
      createdState: [],
      phase: 'committing',
      entries: [{ slot: 0, type: 'dir', priorType: 'dir', destination: '.claude/skills/parked' }],
      createdDirs: [],
    };
    // The literal must be shaped exactly like a journal the real primitive
    // leaves mid-commit, so lane A format drift turns this test red instead
    // of leaving it proving recovery of a state nothing produces.
    const real = captureRealCommittingJournal();
    assert.deepStrictEqual(Object.keys(planted).sort(), Object.keys(real).sort());
    assert.strictEqual(planted.phase, real.phase);
    assert.deepStrictEqual(Object.keys(planted.entries[0]).sort(), Object.keys(real.entries[0]).sort());
    assert.strictEqual(planted.entries[0].type, real.entries[0].type);
    fs.writeFileSync(journalPath(workspace), JSON.stringify(planted));
    const result = applyImport(workspace, sourceRoot, approval);
    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(result.written.length, 2);
    assert.strictEqual(read(workspace, '.claude/skills/parked/SKILL.md'), 'parked');
    assert.strictEqual(fs.existsSync(journalPath(workspace)), false);
  });

  test('a journal that cannot be trusted blocks apply with zero writes', () => {
    const { workspace, sourceRoot, approval, before } = fixture();
    fs.mkdirSync(path.dirname(journalPath(workspace)), { recursive: true });
    fs.writeFileSync(journalPath(workspace), 'not json');
    assert.throws(() => applyImport(workspace, sourceRoot, approval), (e) => e.code === 'ERR_ATOMIC_JOURNAL');
    const kept = tree(workspace).filter((line) => !line.startsWith('.rundock/'));
    assert.deepStrictEqual(kept, before);
  });
});

describe('a fault at any write boundary leaves the pre-apply workspace after recovery', () => {
  const recorded = (() => {
    const { workspace, sourceRoot, approval } = fixture();
    const steps = [];
    applyImport(workspace, sourceRoot, approval, {
      afterStep: (s) => steps.push({ label: `${s.phase}:${s.action}`, destination: s.destination || null }),
    });
    return steps;
  })();
  const boundaries = recorded.map((s) => s.label);

  test('both the agent file and the skill directory contribute write boundaries', () => {
    const touched = new Set(recorded.filter((s) => s.destination)
      .map((s) => s.destination.split(path.sep).slice(-2).join('/')));
    assert.ok(touched.has('agents/scribe.md'), [...touched].join(','));
    assert.ok(touched.has('skills/writer'), [...touched].join(','));
    assert.ok(boundaries.includes('commit:rename'));
    assert.ok(boundaries.includes('prepare:backup'));
  });

  for (let boundary = 1; boundary <= boundaries.length; boundary++) {
    test(`failure after ${boundaries[boundary - 1]} (step ${boundary} of ${boundaries.length})`, () => {
      const { workspace, sourceRoot, approval, before } = fixture();
      let completed = 0;
      assert.throws(() => applyImport(workspace, sourceRoot, approval, {
        afterStep: () => {
          completed += 1;
          if (completed === boundary) throw new Error('injected fault');
        },
      }), /injected fault/);
      assert.deepStrictEqual(tree(workspace), before);
    });
  }
});
