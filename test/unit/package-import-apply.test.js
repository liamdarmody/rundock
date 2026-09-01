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
const { journalPath, IMPORT_SUBDIR } = require('../../lib/workspace/atomic-write.js');
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

function declaresDefault(text) {
  if (!text.startsWith('---\n')) return false;
  const end = text.indexOf('\n---', 4);
  return end !== -1 && /^order:\s*0\s*$/m.test(text.slice(4, end));
}

// Build a valid approval from a source tree and the current workspace, using
// the module's own exported digest and provenance functions, which is exactly
// what the future plan module will do.
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

const AGENT_TEXT = '---\nname: writer\n---\n\nWrite things.\n';
const DEFAULT_AGENT_A = '---\nname: alpha\norder: 0\n---\n\nLead.\n';
const DEFAULT_AGENT_B = '---\nname: beta\norder: 0\n---\n\nAlso lead.\n';

// The standard fixture: an agent to add, a skill to overwrite, a skill to
// skip, and a foreign workspace file nothing may touch.
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
    assert.strictEqual(read(workspace, 'notes/keep.md'), 'foreign');
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
    fs.writeFileSync(journalPath(workspace), JSON.stringify({
      version: 1,
      runId: 'stale',
      createdState: [],
      phase: 'committing',
      entries: [{ slot: 0, type: 'dir', priorType: 'dir', destination: '.claude/skills/parked' }],
      createdDirs: [],
    }));
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
  const boundaries = (() => {
    const { workspace, sourceRoot, approval } = fixture();
    const steps = [];
    applyImport(workspace, sourceRoot, approval, { afterStep: (s) => steps.push(`${s.phase}:${s.action}`) });
    return steps;
  })();

  test('the fixture crosses write boundaries for both a file and a directory destination', () => {
    assert.ok(boundaries.length >= 6, boundaries.join(','));
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
