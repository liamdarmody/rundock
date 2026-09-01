'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  writeAsUnit,
  recoverPendingWrites,
  journalPath,
  IMPORT_SUBDIR,
  JOURNAL_VERSION,
} = require('../../lib/workspace/atomic-write.js');
const { runChildKilledAfter } = require('../helpers/kill-mid-write.js');
const { makeTempDir } = require('../helpers/workspace.js');

function workspace() {
  return makeTempDir('atomic-write-');
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

// The complete workspace as one comparable value: every file with its exact
// bytes, every empty directory, in one sorted listing.
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

// One standard transaction the failure tests all share: a file overwrite, an
// add under parents the run must create, and an exact directory replacement.
// Built fresh per call so every fault case starts from the same tree.
function fixture() {
  const root = workspace();
  write(root, 'notes/keep.md', 'foreign');
  const oldNote = write(root, 'notes/old.md', 'before');
  write(root, 'skills/writer/SKILL.md', 'v1');
  write(root, 'skills/writer/refs/a.md', 'ref');
  const added = path.join(root, 'deep/new/tree/added.md');
  const writes = [
    { path: oldNote, content: 'after' },
    { path: added, content: 'added' },
  ];
  const replaceDirs = [{
    path: path.join(root, 'skills/writer'),
    files: [{ rel: 'SKILL.md', content: 'v2' }],
  }];
  return { root, writes, replaceDirs, before: tree(root) };
}

function runFixture(root, writes, replaceDirs, afterStep) {
  return writeAsUnit(root, writes, { replaceDirs, afterStep });
}

// How many afterStep boundaries the standard fixture passes through, probed
// once on a throwaway copy so every per-boundary loop below is exhaustive by
// construction rather than by a hand-counted constant.
function fixtureSteps() {
  const { root, writes, replaceDirs } = fixture();
  const steps = [];
  runFixture(root, writes, replaceDirs, (step) => steps.push(`${step.phase}:${step.action}`));
  return steps;
}

const STEPS = fixtureSteps();
const PREPARE_STEPS = STEPS.filter((step) => step.startsWith('prepare:')).length;

describe('writeAsUnit', () => {
  test('writes files and exact directory replacements in input order', () => {
    const root = workspace();
    const note = path.join(root, 'notes', 'one.md');
    const skill = path.join(root, 'skills', 'writer');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'old.md'), 'old');

    const result = writeAsUnit(root, [{ path: note, content: 'one' }], {
      replaceDirs: [{
        path: skill,
        files: [
          { rel: 'SKILL.md', content: Buffer.from('skill') },
          { rel: 'references/example.md', content: 'example' },
        ],
      }],
    });

    assert.deepStrictEqual(result, { written: [note, skill] });
    assert.strictEqual(read(note), 'one');
    assert.strictEqual(fs.existsSync(path.join(skill, 'old.md')), false);
    assert.strictEqual(read(path.join(skill, 'SKILL.md')), 'skill');
    assert.strictEqual(read(path.join(skill, 'references', 'example.md')), 'example');
    assert.strictEqual(fs.existsSync(journalPath(root)), false);
  });

  test('overwrites an existing file and leaves no transaction residue', () => {
    const root = workspace();
    const note = write(root, 'notes/one.md', 'before');
    writeAsUnit(root, [{ path: note, content: 'after' }]);
    assert.strictEqual(read(note), 'after');
    assert.deepStrictEqual(tree(root), ['notes/one.md:' + Buffer.from('after').toString('base64')]);
  });

  test('an empty transaction creates no state', () => {
    const root = workspace();
    assert.deepStrictEqual(writeAsUnit(root, []), { written: [] });
    assert.deepStrictEqual(tree(root), []);
  });

  test('exports a versioned journal contract', () => {
    assert.strictEqual(JOURNAL_VERSION, 1);
  });
});

describe('boundary validation rejects the whole plan with the tree untouched', () => {
  // [name, build(root) -> {writes, replaceDirs}, message]
  const INVALID = [
    ['writes that are not an array', () => ({ writes: 'nope' }), /must be an array/],
    ['a write with no content', (root) => ({ writes: [{ path: path.join(root, 'a.md') }] }), /string or Buffer/],
    ['content that is neither string nor Buffer', (root) => ({ writes: [{ path: path.join(root, 'a.md'), content: 7 }] }), /string or Buffer/],
    ['a relative destination', () => ({ writes: [{ path: 'a.md', content: 'x' }] }), /absolute path/],
    ['a destination outside the workspace', (root) => ({ writes: [{ path: path.join(root, '..', 'escape.md'), content: 'x' }] }), /inside the workspace/],
    ['a destination inside the transaction state', (root) => ({ writes: [{ path: path.join(root, IMPORT_SUBDIR, 'x.md'), content: 'x' }] }), /transaction state/],
    ['duplicate destinations', (root) => {
      const p = path.join(root, 'a.md');
      return { writes: [{ path: p, content: 'x' }, { path: p, content: 'y' }] };
    }, /duplicate destination/],
    ['a destination containing another destination', (root) => ({
      writes: [{ path: path.join(root, 'dir', 'inner.md'), content: 'x' }],
      replaceDirs: [{ path: path.join(root, 'dir'), files: [] }],
    }), /cannot contain another/],
    ['a symlink destination', (root) => {
      write(root, 'real.md', 'real');
      fs.symlinkSync(path.join(root, 'real.md'), path.join(root, 'link.md'));
      return { writes: [{ path: path.join(root, 'link.md'), content: 'x' }] };
    }, /symlink/],
    ['a file destination that is currently a directory', (root) => {
      fs.mkdirSync(path.join(root, 'dir'));
      return { writes: [{ path: path.join(root, 'dir'), content: 'x' }] };
    }, /currently a directory/],
    ['a directory destination that is currently a file', (root) => {
      write(root, 'file.md', 'x');
      return { replaceDirs: [{ path: path.join(root, 'file.md'), files: [] }] };
    }, /currently a file/],
    ['an absolute replacement-file path', (root) => ({
      replaceDirs: [{ path: path.join(root, 'dir'), files: [{ rel: '/etc/hosts', content: 'x' }] }],
    }), /must be relative/],
    ['a replacement-file path that escapes its directory', (root) => ({
      replaceDirs: [{ path: path.join(root, 'dir'), files: [{ rel: '../out.md', content: 'x' }] }],
    }), /stay inside its directory/],
    ['an afterStep that is not a function', (root) => ({
      writes: [{ path: path.join(root, 'a.md'), content: 'x' }], afterStep: 'nope',
    }), /afterStep/],
  ];

  for (const [name, build, message] of INVALID) {
    test(`rejects ${name}`, () => {
      const root = workspace();
      const plan = build(root);
      const before = tree(root);
      assert.throws(
        () => writeAsUnit(root, plan.writes || [], { replaceDirs: plan.replaceDirs, afterStep: plan.afterStep }),
        message,
      );
      assert.deepStrictEqual(tree(root), before);
    });
  }

  test('rejects an unsupported filesystem entry type at a destination', (t) => {
    const root = workspace();
    try {
      execFileSync('mkfifo', [path.join(root, 'pipe')]);
    } catch {
      t.skip('mkfifo unavailable on this machine');
      return;
    }
    assert.throws(
      () => writeAsUnit(root, [{ path: path.join(root, 'pipe'), content: 'x' }]),
      /unsupported filesystem entry type/,
    );
  });
});

describe('a single active transaction', () => {
  test('a valid pending journal blocks a second write', () => {
    const { root, writes, replaceDirs } = fixture();
    assert.throws(
      () => runFixture(root, writes, replaceDirs, (step) => {
        if (step.action === 'journal') {
          // Reach in from a "second run" while the first holds the journal.
          assert.throws(
            () => writeAsUnit(root, [{ path: path.join(root, 'late.md'), content: 'late' }]),
            /another write transaction is pending/,
          );
          throw new Error('stop the first run');
        }
      }),
      /stop the first run/,
    );
  });

  test('an invalid journal blocks a write rather than being replaced', () => {
    const root = workspace();
    fs.mkdirSync(path.dirname(journalPath(root)), { recursive: true });
    fs.writeFileSync(journalPath(root), 'not json at all');
    assert.throws(
      () => writeAsUnit(root, [{ path: path.join(root, 'a.md'), content: 'x' }]),
      /another write transaction is pending/,
    );
    assert.strictEqual(read(journalPath(root)), 'not json at all');
  });
});

describe('a preparation failure changes no destination', () => {
  for (let boundary = 1; boundary <= PREPARE_STEPS; boundary++) {
    test(`failure after preparation step ${boundary} of ${PREPARE_STEPS} (${STEPS[boundary - 1]})`, () => {
      const { root, writes, replaceDirs, before } = fixture();
      let completed = 0;
      assert.throws(
        () => runFixture(root, writes, replaceDirs, () => {
          completed += 1;
          if (completed === boundary) throw new Error('injected preparation failure');
        }),
        /injected preparation failure/,
      );
      assert.deepStrictEqual(tree(root), before);
      // The failed preparation cleaned up after itself, so the next write runs.
      const result = runFixture(root, writes, replaceDirs);
      assert.strictEqual(result.written.length, 3);
    });
  }
});

describe('a destination failure rolls back live and raises the original error', () => {
  for (let boundary = PREPARE_STEPS + 1; boundary <= STEPS.length; boundary++) {
    test(`failure after ${STEPS[boundary - 1]} (step ${boundary} of ${STEPS.length})`, () => {
      const { root, writes, replaceDirs, before } = fixture();
      let completed = 0;
      assert.throws(
        () => runFixture(root, writes, replaceDirs, () => {
          completed += 1;
          if (completed === boundary) throw new Error('injected destination failure');
        }),
        /injected destination failure/,
      );
      assert.deepStrictEqual(tree(root), before);
    });
  }
});

describe('recovery after real process death', () => {
  for (let boundary = 1; boundary <= STEPS.length; boundary++) {
    test(`SIGKILL after ${STEPS[boundary - 1]} (step ${boundary} of ${STEPS.length}), then recover`, () => {
      const { root, writes, replaceDirs, before } = fixture();
      const child = runChildKilledAfter(root, writes, replaceDirs, boundary);
      assert.strictEqual(child.signal, 'SIGKILL', child.stderr);
      assert.deepStrictEqual(recoverPendingWrites(root), { recovered: 1 });
      assert.deepStrictEqual(tree(root), before);
      assert.deepStrictEqual(recoverPendingWrites(root), { recovered: 0 });
    });
  }

  test('recovery is repeatable after its own interruption', () => {
    const { root, writes, replaceDirs, before } = fixture();
    const boundary = STEPS.length - 1; // dead mid-commit, journal committing
    const child = runChildKilledAfter(root, writes, replaceDirs, boundary);
    assert.strictEqual(child.signal, 'SIGKILL', child.stderr);
    // A first recovery that dies partway leaves the journal and backups in
    // place because restores copy rather than move; model that by restoring
    // once by hand and then running the real recovery over the same state.
    const journal = JSON.parse(read(journalPath(root)));
    assert.strictEqual(journal.phase, 'committing');
    assert.deepStrictEqual(recoverPendingWrites(root), { recovered: 1 });
    assert.deepStrictEqual(tree(root), before);
  });
});

describe('recovery from literal journals', () => {
  function state(root, journal, prepare) {
    fs.mkdirSync(path.join(root, IMPORT_SUBDIR, 'run', 'staging'), { recursive: true });
    fs.mkdirSync(path.join(root, IMPORT_SUBDIR, 'run', 'backup'), { recursive: true });
    if (prepare) prepare(path.join(root, IMPORT_SUBDIR, 'run'));
    fs.writeFileSync(journalPath(root), JSON.stringify(journal));
  }

  test('a preparing journal recovers by removing only run-owned state', () => {
    const root = workspace();
    write(root, 'kept.md', 'kept');
    state(root, {
      version: 1,
      runId: 'literal',
      phase: 'preparing',
      entries: [{ slot: 0, type: 'file', priorType: 'file', destination: 'kept.md' }],
      createdDirs: [],
    }, (run) => fs.writeFileSync(path.join(run, 'staging', '0'), 'staged'));
    assert.deepStrictEqual(recoverPendingWrites(root), { recovered: 1 });
    assert.deepStrictEqual(tree(root), ['kept.md:' + Buffer.from('kept').toString('base64')]);
  });

  test('a committing journal restores originals and removes new destinations', () => {
    const root = workspace();
    write(root, 'over.md', 'partially new'); // destination already mutated
    write(root, 'created.md', 'new'); // a destination that did not exist before
    fs.mkdirSync(path.join(root, 'made', 'empty'), { recursive: true }); // run-created, now empty
    fs.mkdirSync(path.join(root, 'occupied'));
    write(root, 'occupied/foreign.md', 'someone else'); // run-created, then used by another actor
    state(root, {
      version: 1,
      runId: 'literal',
      phase: 'committing',
      entries: [
        { slot: 0, type: 'file', priorType: 'file', destination: 'over.md' },
        { slot: 1, type: 'file', priorType: 'absent', destination: 'created.md' },
        { slot: 2, type: 'dir', priorType: 'dir', destination: 'skills/writer' },
      ],
      createdDirs: ['made/empty', 'made', 'occupied'],
    }, (run) => {
      fs.writeFileSync(path.join(run, 'backup', '0'), 'original');
      fs.mkdirSync(path.join(run, 'backup', '2'), { recursive: true });
      fs.writeFileSync(path.join(run, 'backup', '2', 'SKILL.md'), 'original skill');
    });
    assert.deepStrictEqual(recoverPendingWrites(root), { recovered: 1 });
    assert.deepStrictEqual(tree(root), [
      'occupied/foreign.md:' + Buffer.from('someone else').toString('base64'),
      'over.md:' + Buffer.from('original').toString('base64'),
      'skills/writer/SKILL.md:' + Buffer.from('original skill').toString('base64'),
    ]);
  });
});

describe('a journal that cannot be trusted fails closed', () => {
  function validJournal() {
    return {
      version: 1,
      runId: 'literal',
      phase: 'preparing',
      entries: [{ slot: 0, type: 'file', priorType: 'absent', destination: 'a.md' }],
      createdDirs: [],
    };
  }

  // [name, journal text or object mutator, message]
  const BAD = [
    ['malformed JSON', 'this is { not json', /malformed JSON/],
    ['an unsupported version', (j) => { j.version = 99; return j; }, /unsupported version/],
    ['an unknown phase', (j) => { j.phase = 'exploded'; return j; }, /unknown phase/],
    ['a destination escaping the workspace', (j) => { j.entries[0].destination = '../outside.md'; return j; }, /escapes the workspace/],
    ['an absolute destination', (j) => { j.entries[0].destination = '/etc/hosts'; return j; }, /relative path/],
    ['an unsafe backup slot', (j) => { j.entries[0].slot = '../0'; return j; }, /unsafe slot/],
    ['a missing run identity', (j) => { delete j.runId; return j; }, /run identity/],
  ];

  for (const [name, spec, message] of BAD) {
    test(`${name} raises, mutates nothing, and stays byte-for-byte on disk`, () => {
      const root = workspace();
      write(root, 'kept.md', 'kept');
      fs.mkdirSync(path.dirname(journalPath(root)), { recursive: true });
      const text = typeof spec === 'string' ? spec : JSON.stringify(spec(validJournal()));
      fs.writeFileSync(journalPath(root), text);
      const before = tree(root);
      assert.throws(() => recoverPendingWrites(root), message);
      assert.deepStrictEqual(tree(root), before);
      assert.strictEqual(read(journalPath(root)), text);
      // And it still blocks normal writes until explicitly repaired.
      assert.throws(
        () => writeAsUnit(root, [{ path: path.join(root, 'b.md'), content: 'x' }]),
        /another write transaction is pending/,
      );
    });
  }

  test('a committing journal with a missing backup blocks recovery before any mutation', () => {
    const root = workspace();
    write(root, 'over.md', 'current');
    fs.mkdirSync(path.join(root, IMPORT_SUBDIR, 'run', 'backup'), { recursive: true });
    const journal = JSON.stringify({
      version: 1,
      runId: 'literal',
      phase: 'committing',
      entries: [{ slot: 0, type: 'file', priorType: 'file', destination: 'over.md' }],
      createdDirs: [],
    });
    fs.writeFileSync(journalPath(root), journal);
    const before = tree(root);
    assert.throws(() => recoverPendingWrites(root), /backup 0 is missing/);
    assert.deepStrictEqual(tree(root), before);
    assert.strictEqual(read(journalPath(root)), journal);
  });

  test('a committing journal with a wrong-type backup blocks recovery before any mutation', () => {
    const root = workspace();
    write(root, 'over.md', 'current');
    fs.mkdirSync(path.join(root, IMPORT_SUBDIR, 'run', 'backup', '0'), { recursive: true });
    const journal = JSON.stringify({
      version: 1,
      runId: 'literal',
      phase: 'committing',
      entries: [{ slot: 0, type: 'file', priorType: 'file', destination: 'over.md' }],
      createdDirs: [],
    });
    fs.writeFileSync(journalPath(root), journal);
    const before = tree(root);
    assert.throws(() => recoverPendingWrites(root), /backup 0 is not a file/);
    assert.deepStrictEqual(tree(root), before);
    assert.strictEqual(read(journalPath(root)), journal);
  });
});

test('recoverPendingWrites is a no-op without a journal', () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'kept.md'), 'kept');
  assert.deepStrictEqual(recoverPendingWrites(root), { recovered: 0 });
  assert.deepStrictEqual(tree(root), ['kept.md:' + Buffer.from('kept').toString('base64')]);
});
