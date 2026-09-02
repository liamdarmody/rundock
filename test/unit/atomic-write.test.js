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

// The shared transaction, built fresh per fault case.
function fixture() {
  const root = workspace();
  write(root, 'notes/keep.md', 'foreign');
  const oldNote = write(root, 'notes/old.md', 'before');
  write(root, 'skills/writer/SKILL.md', 'v1');
  write(root, 'skills/writer/refs/a.md', 'ref');
  // A pre-existing EMPTY parent holding a destination: it must survive every
  // rollback and recovery, unlike the parents the run itself creates.
  fs.mkdirSync(path.join(root, 'kept-empty'));
  const added = path.join(root, 'deep/new/tree/added.md');
  const writes = [
    { path: oldNote, content: 'after' },
    { path: added, content: 'added' },
    { path: path.join(root, 'kept-empty', 'new.md'), content: 'kept new' },
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

// The boundaries the standard fixture passes through, probed once so the
// per-boundary loops below are exhaustive by construction.
function fixtureSteps() {
  const { root, writes, replaceDirs } = fixture();
  const steps = [];
  runFixture(root, writes, replaceDirs, (step) => steps.push(`${step.phase}:${step.action}`));
  return steps;
}

const STEPS = fixtureSteps();
const PREPARE_STEPS = STEPS.filter((step) => step.startsWith('prepare:')).length;

// The probed list is pinned to an explicit literal before any loop uses it,
// so a vanished or reordered boundary turns the suite red instead of
// silently deleting the tests it generates.
test('the standard fixture crosses exactly the fourteen recorded boundaries, in order', () => {
  assert.deepStrictEqual(STEPS, [
    'prepare:journal', 'prepare:stage', 'prepare:stage', 'prepare:stage', 'prepare:stage',
    'prepare:backup', 'prepare:backup', 'commit:transition',
    // overwrite pair, added file, file under the kept empty parent, replacement pair
    'commit:remove', 'commit:rename', 'commit:rename', 'commit:rename', 'commit:remove', 'commit:rename',
  ]);
});

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
    ['the transaction-state directory itself as a destination', (root) => ({ replaceDirs: [{ path: path.join(root, IMPORT_SUBDIR), files: [] }] }), /transaction state/],
    ['an ancestor of the transaction state as a destination', (root) => ({ writes: [{ path: path.join(root, '.rundock'), content: 'x' }] }), /transaction state/],
    ['a destination beside the import root but under the state root', (root) => ({ writes: [{ path: path.join(root, '.rundock', 'other.md'), content: 'x' }] }), /transaction state/],
    ['a case-variant of the transaction state as a destination', (root) => ({ writes: [{ path: path.join(root, '.RUNDOCK', 'import', 'run', 'backup', '0'), content: 'x' }] }), /transaction state/],
    ['case-variant duplicate destinations', (root) => ({ writes: [{ path: path.join(root, 'A.md'), content: 'x' }, { path: path.join(root, 'a.md'), content: 'y' }] }), /duplicate destination/],
    ['replaceDirs that is not an array', () => ({ replaceDirs: 'nope' }), /replaceDirs must be an array/],
    ['a null directory-replacement entry', () => ({ replaceDirs: [null] }), /replacement files must be an array/],
    ['a directory replacement whose files is not an array', (root) => ({ replaceDirs: [{ path: path.join(root, 'dir'), files: 'nope' }] }), /replacement files must be an array/],
    ['a replacement file whose content is neither string nor Buffer', (root) => ({ replaceDirs: [{ path: path.join(root, 'dir'), files: [{ rel: 'a.md', content: 9 }] }] }), /replacement file content must be a string or Buffer/],
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

  test('rejects a destination that reaches through a symlinked directory', () => {
    const root = workspace();
    const outside = workspace();
    const outsideFile = write(outside, 'a.md', 'external');
    fs.symlinkSync(outside, path.join(root, 'notes'));
    assert.throws(
      () => writeAsUnit(root, [{ path: path.join(root, 'notes', 'a.md'), content: 'x' }]),
      /symlink/,
    );
    assert.strictEqual(read(outsideFile), 'external');
    assert.strictEqual(fs.existsSync(path.join(root, '.rundock')), false);
  });

  // [name, workspace value or builder]
  const BAD_WORKSPACES = [
    ['a workspace that is not a string', () => 7],
    ['an empty workspace path', () => ''],
    ['a workspace path that is a file', (root) => write(root, 'file.md', 'x')],
  ];

  for (const [name, build] of BAD_WORKSPACES) {
    test(`writeAsUnit and recoverPendingWrites both reject ${name}`, () => {
      const root = workspace();
      const bad = build(root);
      const before = tree(root);
      assert.throws(() => writeAsUnit(bad, [{ path: path.join(root, 'a.md'), content: 'x' }]));
      assert.throws(() => recoverPendingWrites(bad));
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
      assert.strictEqual(result.written.length, 4);
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

  test('a committing recovery interrupted partway completes when re-run from the same state', () => {
    // The pre-state the journal describes: two files that both existed.
    const root = workspace();
    const pre = [
      'a.md:' + Buffer.from('original a').toString('base64'),
      'blocked/inner.md:' + Buffer.from('original b').toString('base64'),
    ];
    // Mid-commit state of a died run: first destination mutated, second's
    // parent replaced by a file so its restore cannot complete yet.
    write(root, 'a.md', 'new a');
    write(root, 'blocked', 'obstruction');
    fs.mkdirSync(path.join(root, IMPORT_SUBDIR, 'run', 'backup'), { recursive: true });
    fs.writeFileSync(path.join(root, IMPORT_SUBDIR, 'run', 'backup', '0'), 'original a');
    fs.writeFileSync(path.join(root, IMPORT_SUBDIR, 'run', 'backup', '1'), 'original b');
    const journal = JSON.stringify({
      version: 1,
      runId: 'literal',
      createdState: ['.rundock/import', '.rundock'],
      phase: 'committing',
      entries: [
        { slot: 0, type: 'file', priorType: 'file', destination: 'a.md' },
        { slot: 1, type: 'file', priorType: 'file', destination: 'blocked/inner.md' },
      ],
      createdDirs: [],
    });
    fs.writeFileSync(journalPath(root), journal);

    // The first recovery restores a.md, then fails on the obstructed entry.
    assert.throws(() => recoverPendingWrites(root));
    assert.strictEqual(read(path.join(root, 'a.md')), 'original a');
    // The journal and COMPLETE backup set survive the failed attempt:
    // restores copy rather than move. A renaming implementation would have
    // consumed backup 0 and fail the re-run below.
    assert.strictEqual(read(journalPath(root)), journal);
    assert.strictEqual(read(path.join(root, IMPORT_SUBDIR, 'run', 'backup', '0')), 'original a');
    assert.strictEqual(read(path.join(root, IMPORT_SUBDIR, 'run', 'backup', '1')), 'original b');

    // Clear the obstruction; the same recovery now completes from the same
    // on-disk state and lands the exact pre-state tree.
    fs.rmSync(path.join(root, 'blocked'));
    assert.deepStrictEqual(recoverPendingWrites(root), { recovered: 1 });
    assert.deepStrictEqual(tree(root), pre);
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
      createdState: ['.rundock/import', '.rundock'],
      phase: 'preparing',
      entries: [{ slot: 0, type: 'file', priorType: 'file', destination: 'kept.md' }],
      createdDirs: [],
    }, (run) => fs.writeFileSync(path.join(run, 'staging', '0'), 'staged'));
    assert.deepStrictEqual(recoverPendingWrites(root), { recovered: 1 });
    assert.deepStrictEqual(tree(root), ['kept.md:' + Buffer.from('kept').toString('base64')]);
  });

  test('recovery removes a stale journal temporary left by an interrupted update', () => {
    const root = workspace();
    write(root, 'kept.md', 'kept');
    state(root, { version: 1, runId: 'literal', createdState: ['.rundock/import', '.rundock'], phase: 'preparing', entries: [], createdDirs: [] });
    fs.writeFileSync(`${journalPath(root)}.literal.tmp`, 'half-written update');
    assert.deepStrictEqual(recoverPendingWrites(root), { recovered: 1 });
    // Pre-state with no `.rundock`: the temporary must not survive.
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
      createdState: ['.rundock/import', '.rundock'],
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
      createdState: [],
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
    ['a destination escaping the workspace', (j) => { j.entries[0].destination = '../outside.md'; return j; }, /stay inside the workspace/],
    ['an absolute destination', (j) => { j.entries[0].destination = '/etc/hosts'; return j; }, /relative path/],
    ['an unsafe backup slot', (j) => { j.entries[0].slot = '../0'; return j; }, /unsafe slot/],
    ['a missing run identity', (j) => { delete j.runId; return j; }, /run identity/],
    ['a destination that uses transaction state', (j) => { j.entries[0].destination = '.rundock'; return j; }, /transaction state/],
    ['a missing state-ownership record', (j) => { delete j.createdState; return j; }, /state-ownership/],
    ['an escaping state-ownership record', (j) => { j.createdState = ['../..']; return j; }, /state-ownership/],
    ['an in-workspace but non-state state-ownership record', (j) => { j.createdState = ['notes']; return j; }, /state-ownership/],
  ];

  for (const [name, spec, message] of BAD) {
    test(`${name} raises, mutates nothing, and stays byte-for-byte on disk`, () => {
      const root = workspace();
      write(root, 'kept.md', 'kept');
      fs.mkdirSync(path.dirname(journalPath(root)), { recursive: true });
      const text = typeof spec === 'string' ? spec : JSON.stringify(spec(validJournal()));
      fs.writeFileSync(journalPath(root), text);
      const before = tree(root);
      let raised;
      try { recoverPendingWrites(root); } catch (e) { raised = e; }
      assert.match(raised.message, message);
      assert.strictEqual(raised.code, 'ERR_ATOMIC_JOURNAL');
      assert.deepStrictEqual(tree(root), before);
      assert.strictEqual(read(journalPath(root)), text);
      // And it still blocks normal writes until explicitly repaired.
      assert.throws(
        () => writeAsUnit(root, [{ path: path.join(root, 'b.md'), content: 'x' }]),
        /another write transaction is pending/,
      );
    });
  }

  test('a journal that exists but cannot be read raises and keeps blocking writes', () => {
    const root = workspace();
    write(root, 'kept.md', 'kept');
    fs.mkdirSync(journalPath(root), { recursive: true }); // a directory at the journal path
    const before = tree(root);
    let raised;
    try {
      recoverPendingWrites(root);
    } catch (e) {
      raised = e;
    }
    assert.match(raised.message, /unreadable/);
    assert.strictEqual(raised.code, 'ERR_ATOMIC_JOURNAL');
    assert.deepStrictEqual(tree(root), before);
    assert.strictEqual(fs.statSync(journalPath(root)).isDirectory(), true);
    assert.throws(
      () => writeAsUnit(root, [{ path: path.join(root, 'b.md'), content: 'x' }]),
      /another write transaction is pending/,
    );
  });

  for (const [name, dir, message] of [
    ['escaping created-directory record', '../out', /stay inside the workspace/],
    ['absolute created-directory record', '/abs', /must be a relative path/],
  ]) {
    test(`an ${name} blocks a committing recovery before any mutation`, () => {
      const root = workspace();
      write(root, 'over.md', 'partially new');
      fs.mkdirSync(path.join(root, IMPORT_SUBDIR, 'run', 'backup'), { recursive: true });
      fs.writeFileSync(path.join(root, IMPORT_SUBDIR, 'run', 'backup', '0'), 'original');
      const journal = JSON.stringify({ version: 1, runId: 'literal', createdState: [], phase: 'committing', entries: [{ slot: 0, type: 'file', priorType: 'file', destination: 'over.md' }], createdDirs: [dir] });
      fs.writeFileSync(journalPath(root), journal);
      const before = tree(root);
      assert.throws(() => recoverPendingWrites(root), message);
      // Validation refused the journal before restoring anything: the
      // half-written destination is untouched and the journal preserved.
      assert.deepStrictEqual(tree(root), before);
      assert.strictEqual(read(journalPath(root)), journal);
      assert.throws(
        () => writeAsUnit(root, [{ path: path.join(root, 'b.md'), content: 'x' }]),
        /another write transaction is pending/,
      );
    });
  }

  test('an escaping state-ownership record blocks a committing recovery and touches nothing outside', () => {
    const root = workspace();
    write(root, 'over.md', 'partially new');
    fs.mkdirSync(path.join(root, IMPORT_SUBDIR, 'run', 'backup'), { recursive: true });
    fs.writeFileSync(path.join(root, IMPORT_SUBDIR, 'run', 'backup', '0'), 'original');
    const journal = JSON.stringify({ version: 1, runId: 'literal', createdState: ['../..'], phase: 'committing', entries: [{ slot: 0, type: 'file', priorType: 'file', destination: 'over.md' }], createdDirs: [] });
    fs.writeFileSync(journalPath(root), journal);
    const before = tree(root);
    const outside = path.resolve(root, '..');
    let raised;
    try { recoverPendingWrites(root); } catch (e) { raised = e; }
    assert.match(raised.message, /state-ownership/);
    assert.strictEqual(raised.code, 'ERR_ATOMIC_JOURNAL');
    assert.deepStrictEqual(tree(root), before);
    assert.strictEqual(read(journalPath(root)), journal);
    assert.strictEqual(fs.statSync(outside).isDirectory(), true); // the escape target survives
    assert.throws(
      () => writeAsUnit(root, [{ path: path.join(root, 'b.md'), content: 'x' }]),
      /another write transaction is pending/,
    );
  });

  test('a committing journal with a missing backup blocks recovery before any mutation', () => {
    const root = workspace();
    write(root, 'over.md', 'current');
    fs.mkdirSync(path.join(root, IMPORT_SUBDIR, 'run', 'backup'), { recursive: true });
    const journal = JSON.stringify({ version: 1, runId: 'literal', createdState: [], phase: 'committing', entries: [{ slot: 0, type: 'file', priorType: 'file', destination: 'over.md' }], createdDirs: [] });
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
    const journal = JSON.stringify({ version: 1, runId: 'literal', createdState: [], phase: 'committing', entries: [{ slot: 0, type: 'file', priorType: 'file', destination: 'over.md' }], createdDirs: [] });
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
