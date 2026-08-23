'use strict';
// The timezone a schedule was set in, stored as location words.
//
// THE ZONE THIS PROCESS RUNS IN IS SET HERE, before the first require, and it
// is the whole reason these tests can say anything at all.
//
// The easiest wrong answer to "what timezone was this schedule set in" is
// `Intl.DateTimeFormat().resolvedOptions().timeZone`. It returns location
// words and looks exactly right. It answers a different question: what this
// machine is set to, rather than what the person chose when they built the
// schedule. A test that inherited the runner's zone could not tell the two
// apart, because on the machine that wrote the code they are the same string.
//
// So the host's zone is pinned to a known value here, and every zone these
// tests store is a different one, chosen in the test and never read from
// anywhere. The assertions then hold identically in London, in Auckland and on
// a continuous integration runner, and a value that arrived from the machine
// fails them everywhere rather than passing everywhere.
//
// Its own file, for the same reason test/unit/scheduler-slots-dst.test.js is:
// node --test gives every file its own process, so setting the zone here
// changes nothing anywhere else, and it has to be set before the first require.
process.env.TZ = 'UTC';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeRoutine, parseRoutineBlocks, updateRoutineBlock, appendRoutineBlock,
  computePlanHash, migrateAgentRoutines,
} = require('../../lib/agents/routines.js');

// The machine's zone, as a constant this file controls rather than a reading
// it inherits. Every stored zone below differs from it, which is what makes
// "the stored value is not the machine's" an assertion instead of a hope.
const HOST_ZONE = 'UTC';
// Two zones, neither of which is the host's, and neither of which any code
// under test could have derived from anything. Kiritimati is +14 and Niue is
// -11, so a value that leaked in from the machine is not one clock change away
// from these, it is a different string entirely.
const SET_ZONE = 'Pacific/Kiritimati';
const OTHER_ZONE = 'Pacific/Niue';

test('the host zone is pinned, so a zone differing from it is a real difference', () => {
  // If this fails, every AC-3 assertion below is comparing a value against
  // whatever the runner happened to be set to, which is the defect rather than
  // the check. It is asserted rather than assumed for that reason.
  assert.strictEqual(Intl.DateTimeFormat().resolvedOptions().timeZone, HOST_ZONE);
  assert.notStrictEqual(SET_ZONE, HOST_ZONE);
  assert.notStrictEqual(OTHER_ZONE, HOST_ZONE);
});

// A file carrying more than this card knows about: a frontmatter key nobody
// declared, a key inside the routine block the writer has never heard of, a
// second routine, a key after the section, and a body. Round-tripping a new
// field on a file like this is the claim; round-tripping it on a file
// containing only that field would not be.
const FIXTURE = [
  '---',
  'name: penn',
  'displayName: Penn',
  'aKeyThisCardNeverHeardOf: keep me exactly',
  'routines:',
  '  - name: morning-digest',
  '    schedule: every day at 08:00',
  '    prompt: Run the digest',
  '    aRoutineKeyTheWriterDoesNotKnow: keep me too',
  '  - name: weekly-review',
  '    schedule: every friday at 16:00',
  '    prompt: Review the week',
  'trailingKey: still here',
  '---',
  '',
  '# Penn',
  '',
  'Body text the writer knows nothing about.',
  '',
].join('\n');

function frontmatterOf(content) {
  return content.match(/^---\n([\s\S]*?)\n---/)[1];
}

function readRoutine(content, name) {
  return parseRoutineBlocks(frontmatterOf(content))
    .map(raw => normalizeRoutine(raw, { owner: 'penn' }))
    .find(r => r.name === name);
}

// What a quoted value reads back as, so the assertion says the zone rather
// than repeating the writer's own unquoting.
function unquoted(value) {
  return value.replace(/^"(.*)"$/, '$1');
}

function splitFile(content) {
  const end = content.indexOf('\n---\n', 4);
  return { frontmatter: content.slice(4, end), body: content.slice(end + 5) };
}

describe('a schedule stores the timezone it was set in', () => {
  test('a timezone is read off the file as the location words it carries', () => {
    assert.strictEqual(
      normalizeRoutine({ name: 'r', timezone: SET_ZONE }).timezone, SET_ZONE);
    // Authors quote things, and every other typed field in this module is read
    // through the same unquoting.
    assert.strictEqual(
      normalizeRoutine({ name: 'r', timezone: `"${SET_ZONE}"` }).timezone, SET_ZONE);
    assert.strictEqual(
      normalizeRoutine({ name: 'r', timezone: `  ${SET_ZONE}  ` }).timezone, SET_ZONE);
  });

  test('a timezone survives a write-then-read cycle on a file carrying fields this card never touches', () => {
    const updated = updateRoutineBlock(FIXTURE, 'morning-digest', { timezone: SET_ZONE });

    // The write landed. Two files that both lost the field would also compare
    // equal, so prove it is there before claiming anything was preserved.
    assert.strictEqual(readRoutine(updated, 'morning-digest').timezone, SET_ZONE);
    assert.ok(updated.includes(`    timezone: ${SET_ZONE}`),
      'the zone was not written as the words that were given');

    const before = splitFile(FIXTURE).frontmatter.split('\n');
    const after = splitFile(updated).frontmatter.split('\n');
    // Everything above the edited block, byte for byte.
    const head = before.indexOf('  - name: morning-digest');
    assert.deepStrictEqual(after.slice(0, head), before.slice(0, head));
    // Everything from the next routine onward, which covers the second routine
    // and the top-level key that follows the section.
    assert.deepStrictEqual(
      after.slice(after.indexOf('  - name: weekly-review')),
      before.slice(before.indexOf('  - name: weekly-review')));
    // The unknown key inside the block that was edited.
    assert.ok(after.includes('    aRoutineKeyTheWriterDoesNotKnow: keep me too'),
      'a key inside the edited routine was dropped');
    // And the body.
    assert.strictEqual(splitFile(updated).body, splitFile(FIXTURE).body);

    // A second cycle, so "round trip" means repeatedly rather than once.
    const twice = updateRoutineBlock(updated, 'morning-digest', { timezone: SET_ZONE });
    assert.strictEqual(twice, updated);

    // THE ASSERTION THAT SAYS THE FIELD IS TYPED RATHER THAN CARRIED.
    //
    // The block parser copies every `key: value` it finds with no whitelist,
    // so an unrecognised `timezone` already arrives on the routine as the raw
    // text of its line. That is why the assertions above hold on the reader
    // this card started from as well: they cannot tell a field the model
    // knows from a string nobody typed. A quoted value can: the raw text
    // carries the quotes and the typed read does not, on the same terms as
    // every other field this module types.
    const quoted = updateRoutineBlock(FIXTURE, 'morning-digest', { timezone: `"${SET_ZONE}"` });
    assert.ok(quoted.includes(`    timezone: "${SET_ZONE}"`), 'the quotes were not written');
    assert.strictEqual(readRoutine(quoted, 'morning-digest').timezone, SET_ZONE);
  });

  test('a routine with no timezone is distinguishable from one whose timezone is blank', () => {
    // Never recorded. Every routine written before this field existed is here,
    // and a later card deciding what to do about a routine with no zone has to
    // be able to tell this from the line below.
    assert.strictEqual(normalizeRoutine({ name: 'r' }).timezone, null);
    // Declared and left empty, which is somebody saying something rather than
    // saying nothing.
    assert.strictEqual(normalizeRoutine({ name: 'r', timezone: '' }).timezone, '');
    assert.strictEqual(normalizeRoutine({ name: 'r', timezone: '""' }).timezone, '');

    // The same distinction off a real file rather than out of a raw object,
    // because the parser is what turns a bare `timezone:` line into a value.
    const blank = FIXTURE.replace(
      '    prompt: Run the digest\n', '    prompt: Run the digest\n    timezone:\n');
    assert.strictEqual(readRoutine(blank, 'morning-digest').timezone, '');
    assert.strictEqual(readRoutine(FIXTURE, 'morning-digest').timezone, null);

    // And a blank one round-trips as a blank rather than as the four letters
    // n-u-l-l or as an absence.
    const back = updateRoutineBlock(blank, 'morning-digest', readRoutine(blank, 'morning-digest'));
    assert.strictEqual(readRoutine(back, 'morning-digest').timezone, '');
    assert.ok(!back.includes('timezone: null'), 'the text "null" reached the file');
  });

  test('the stored timezone is the one that was set, never the one this machine is in', () => {
    const created = appendRoutineBlock(FIXTURE, {
      name: 'evening-digest', schedule: 'every day at 18:00', prompt: 'Run it',
      timezone: SET_ZONE,
    });
    const routine = readRoutine(created, 'evening-digest');

    assert.strictEqual(routine.timezone, SET_ZONE);
    // The assertion this card exists for. The machine is set to HOST_ZONE and
    // the stored value is not it, so no path from the machine's zone to the
    // file can have been taken.
    assert.notStrictEqual(routine.timezone, HOST_ZONE);
    assert.ok(!created.includes(HOST_ZONE), 'the machine\'s zone reached the file');

    // A second routine set in a different zone keeps its own, so the value
    // travels with the schedule rather than with the process.
    const both = appendRoutineBlock(created, {
      name: 'night-digest', schedule: 'every day at 23:00', prompt: 'Run it late',
      timezone: OTHER_ZONE,
    });
    assert.strictEqual(readRoutine(both, 'evening-digest').timezone, SET_ZONE);
    assert.strictEqual(readRoutine(both, 'night-digest').timezone, OTHER_ZONE);
  });

  test('a routine created without a timezone is left without one rather than filled in from the machine', () => {
    const created = appendRoutineBlock(FIXTURE, {
      name: 'evening-digest', schedule: 'every day at 18:00', prompt: 'Run it',
    });
    assert.strictEqual(readRoutine(created, 'evening-digest').timezone, null);
    assert.ok(!/timezone:/.test(created), 'a timezone was invented for a routine that named none');
    assert.ok(!created.includes(HOST_ZONE), 'the machine\'s zone reached the file');
  });

  test('a value that is not location words is refused rather than stored', () => {
    const refused = [
      '+01:00',      // an offset is true until the next clock change
      '-05:00',
      'GMT+1',
      'UTC+2',
      'BST',         // an abbreviation names several places at once
      'PST',
      'UTC',         // names no place, and is what a machine in a container says
      '',            // an empty zone is not a zone to CREATE: see the road below
      '""',          // the same thing written the way an author writes things
      'Europe',      // an area with no place in it
      'Europe//London',
      '../../etc/passwd',
    ];
    for (const value of refused) {
      assert.throws(
        () => appendRoutineBlock(FIXTURE, {
          name: 'evening-digest', schedule: 'every day at 18:00', prompt: 'p', timezone: value,
        }),
        /timezone/i,
        `"${value}" was accepted as a timezone`);
    }

    // And the shapes a real zone comes in are accepted, including the
    // three-part names and the ones carrying digits or a sign.
    for (const value of [
      'Europe/London', 'America/Argentina/Buenos_Aires', 'Australia/Lord_Howe',
      'America/Port-au-Prince', 'Etc/GMT+10',
    ]) {
      const created = appendRoutineBlock(FIXTURE, {
        name: 'evening-digest', schedule: 'every day at 18:00', prompt: 'p', timezone: value,
      });
      assert.strictEqual(readRoutine(created, 'evening-digest').timezone, value);
    }
  });
});

describe('the road every edit takes', () => {
  // THE CHECK BELONGS TO THE WRITER, NOT TO THE PATH THAT CREATES A ROUTINE.
  //
  // `appendRoutineBlock` makes a routine that is not in the file yet.
  // `updateRoutineBlock` changes one that is, and it is the only path that
  // writes a key at all: creating goes through it too. A rule enforced on the
  // creating road alone would hold for exactly as long as nothing edits a
  // routine, and an edit flow is the next thing to be built.
  //
  // So these tests go through the writer directly rather than through append.
  test('a value that is not location words is refused on the road every edit takes', () => {
    for (const value of ['+01:00', '-05:00', 'GMT+1', 'UTC+2', 'BST', 'PST', 'UTC', 'Europe', 'Europe//London']) {
      assert.throws(
        () => updateRoutineBlock(FIXTURE, 'morning-digest', { timezone: value }),
        /timezone/i,
        `"${value}" was written into a file by the general writer`);
    }
    // A refusal is a refusal on every key in the same write, so an edit that
    // carries a good prompt and a bad zone writes neither.
    assert.throws(
      () => updateRoutineBlock(FIXTURE, 'morning-digest', { prompt: 'Run it differently', timezone: 'BST' }),
      /timezone/i);
    // Location words land, quoted or bare, on this road as on the other.
    for (const value of ['Europe/London', `"${SET_ZONE}"`]) {
      const updated = updateRoutineBlock(FIXTURE, 'morning-digest', { timezone: value });
      assert.strictEqual(readRoutine(updated, 'morning-digest').timezone, unquoted(value));
    }
  });

  test('a zone somebody recorded can still be cleared, which is what an edit that removes one did', () => {
    // Empty is how this module clears a field, and removing a zone is an
    // ordinary edit. It is not the same as never having recorded one: the key
    // stays, declared and blank, which is the honest record of what happened.
    const set = updateRoutineBlock(FIXTURE, 'morning-digest', { timezone: SET_ZONE });
    const cleared = updateRoutineBlock(set, 'morning-digest', { timezone: '' });
    assert.strictEqual(readRoutine(cleared, 'morning-digest').timezone, '');
    assert.notStrictEqual(readRoutine(cleared, 'morning-digest').timezone, null);
    assert.ok(cleared.includes('    timezone:'), 'the key was removed rather than emptied');
  });
});

describe('whether a timezone invalidates a plan approval', () => {
  const plan = (fields) => computePlanHash(normalizeRoutine({
    name: 'morning-digest', prompt: 'Run the digest', skill: 'content-linter', ...fields,
  }, { owner: 'penn' }));

  // THE DECISION THIS CARD CANNOT AVOID, pinned so it cannot be reversed by
  // omission. A plan approval covers what a routine does. A timezone changes
  // when it runs, which is the same class as the schedule, and the schedule is
  // already excluded because re-approving a routine somebody moved by ten
  // minutes makes approval worthless. Moving one across a zone is that same
  // edit said differently.
  test('a timezone does not reach the plan hash, so changing one does not invalidate an approval', () => {
    const base = plan({});
    assert.strictEqual(plan({ timezone: SET_ZONE }), base);
    assert.strictEqual(plan({ timezone: OTHER_ZONE }), base);
    assert.strictEqual(plan({ timezone: '' }), base);
    // The pair that says it directly: two zones, same plan.
    assert.strictEqual(plan({ timezone: SET_ZONE }), plan({ timezone: OTHER_ZONE }));
    // And the hash still notices what a routine DOES, so the equalities above
    // are not two hashes of nothing.
    assert.notStrictEqual(plan({ skill: 'voice-editor' }), base);
  });

  test('the hash a migration stamps is the same whether or not the routine names a zone', () => {
    // AC-9 read the only way it can be, given the decision above: a routine
    // that gains its plan record in the same pass that meets its timezone must
    // land on the hash it would have had without one, or every existing
    // approval breaks the first time the field is written next to it.
    const withZone = normalizeRoutine(
      { name: 'r', prompt: 'Run the digest', timezone: SET_ZONE }, { owner: 'penn' });
    const without = normalizeRoutine(
      { name: 'r', prompt: 'Run the digest' }, { owner: 'penn' });
    assert.strictEqual(computePlanHash(withZone), computePlanHash(without));
  });
});

// ===== MIGRATION =====

const LEGACY = [
  '---',
  'name: penn',
  'displayName: Penn',
  'aKeyThisCardNeverHeardOf: keep me exactly',
  'routines:',
  '  - name: morning-digest',
  '    schedule: every day at 08:00',
  '    prompt: Run the digest',
  '---',
  '',
  '# Penn',
  '',
  'Body text the migration is not allowed to touch.',
  '',
].join('\n');

// A throwaway file per test, under the system temp directory, removed after.
// Nothing here reads the home directory or the real workspace.
function withFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-timezone-'));
  const file = path.join(dir, 'penn.md');
  fs.writeFileSync(file, content);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The migration announces itself on stdout when it does something, and
// "it said nothing" is half of what idempotent means here.
function capturingLogs(fn) {
  const logs = [];
  const realLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try { fn(); } finally { console.log = realLog; }
  return logs.filter(l => l.includes('[migrate]'));
}

function migrate(file) {
  return migrateAgentRoutines(file, fs.readFileSync(file, 'utf-8'), { owner: 'penn' });
}

describe('migrating a routine that predates the field', () => {
  test('the migration invents no timezone, least of all the machine\'s', () => {
    withFile(LEGACY, (file) => {
      const migrated = migrate(file);
      // The migration ran: it stamps a plan hash, which nothing defaults.
      assert.match(migrated, /planHash: [0-9a-f]{64}/);
      // And it left the field alone. There is no true value for a routine
      // written before anybody recorded one, and the only value available to
      // this process is the machine's.
      assert.strictEqual(readRoutine(migrated, 'morning-digest').timezone, null);
      assert.ok(!/timezone:/.test(migrated), 'the migration wrote a timezone');
      assert.ok(!migrated.includes(HOST_ZONE), 'the machine\'s zone reached the file');
    });
  });

  // AC-5 AND AC-13 BELONG TO THIS FIXTURE, and which fixture they run on is
  // the whole proof rather than a detail of it.
  //
  // A routine that already exists carries no `timezone` key, by definition: it
  // was written before the field was. That is the only population the
  // idempotence question is about, and the only one that can exhibit the
  // defect. A file that already carries the field answers `needsMigration`
  // with false on a second pass whether or not `timezone` is a migrated key,
  // so a two-pass comparison over one of those cannot fail for the thing it is
  // written to guard. It reads as a proof and is not one.
  //
  // Here it can fail. Were `timezone` a migrated key, this file would never be
  // finished: the writer skips an absent value, so the key is never written,
  // `needsMigration` stays true for ever, and every read rewrites the file and
  // announces it. Byte-identical content would still be byte-identical. The
  // silence is what notices.
  test('running the migration twice over a routine that predates the field changes nothing and says nothing', () => {
    withFile(LEGACY, (file) => {
      let first;
      const firstLogs = capturingLogs(() => { first = migrate(file); });
      // The first pass did something. Without this, a suite in which nothing
      // is ever migrated passes the comparison below by doing nothing twice.
      assert.strictEqual(firstLogs.length, 1, `the first pass said: ${JSON.stringify(firstLogs)}`);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), first, 'the first pass did not persist');
      assert.ok(!/timezone:/.test(first), 'the migration wrote a timezone');

      let second;
      const logs = capturingLogs(() => { second = migrate(file); });

      // Byte for byte, both in what came back and in what is on disk.
      assert.strictEqual(second, first);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), first);
      // And nothing happened at all: a pass that rewrites the same content and
      // announces it has still done something, on every read, for ever.
      assert.deepStrictEqual(logs, [],
        'the second pass migrated a file with nothing left to migrate');
    });
  });

  test('running the migration twice over a routine that carries a timezone changes nothing and says nothing', () => {
    const withZone = LEGACY.replace(
      '    prompt: Run the digest\n',
      `    prompt: Run the digest\n    timezone: ${SET_ZONE}\n`);
    withFile(withZone, (file) => {
      const first = migrate(file);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), first, 'the first pass did not persist');
      assert.strictEqual(readRoutine(first, 'morning-digest').timezone, SET_ZONE);

      let second;
      const logs = capturingLogs(() => { second = migrate(file); });

      // Byte for byte, both in what came back and in what is on disk.
      assert.strictEqual(second, first);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), first);
      // Identical bytes are not enough on their own: a second pass that
      // rewrites the same content and announces it has still done something.
      assert.deepStrictEqual(logs, []);
    });
  });

  test('a routine already carrying the field is left byte-identical by a migration pass', () => {
    // A file with nothing left to migrate, made by migrating one and then
    // adding the timezone to the result, so the only thing the pass below
    // could react to is the field this card adds.
    const settled = withFile(LEGACY, (file) => migrate(file))
      .replace('    prompt: Run the digest\n',
        `    prompt: Run the digest\n    timezone: ${SET_ZONE}\n`);
    withFile(settled, (file) => {
      let after;
      const logs = capturingLogs(() => { after = migrate(file); });
      assert.strictEqual(after, settled);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), settled);
      assert.deepStrictEqual(logs, []);
      assert.strictEqual(readRoutine(after, 'morning-digest').timezone, SET_ZONE);
    });
  });

  test('the pre-migration backup still holds the file as it was before anything touched it', () => {
    const withZone = LEGACY.replace(
      '    prompt: Run the digest\n',
      `    prompt: Run the digest\n    timezone: ${SET_ZONE}\n`);
    withFile(withZone, (file) => {
      migrate(file);
      const backup = `${file}.pre-routine-model-backup`;
      assert.ok(fs.existsSync(backup), 'no backup was written');
      assert.strictEqual(fs.readFileSync(backup, 'utf-8'), withZone);

      // A second un-migrated routine forces another migrating write. The
      // backup must still hold the ORIGINAL file.
      fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(
        '  - name: morning-digest',
        '  - name: handover\n    schedule: every friday at 16:00\n    prompt: Hand over\n  - name: morning-digest'));
      migrate(file);
      assert.ok(fs.readFileSync(file, 'utf-8').includes('  - name: handover'), 'the second routine was lost');
      assert.strictEqual(fs.readFileSync(backup, 'utf-8'), withZone, 'the backup was overwritten');
    });
  });
});

// ===== THE BOUNDARY WITH THE SCHEDULER =====

const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');

// A private copy, so wiring a clock here never leaks into the shared instance
// the rest of the suite runs against. Same technique as
// test/unit/scheduler-lib.test.js.
function freshScheduler() {
  const cached = require.cache[SCHEDULER_KEY];
  delete require.cache[SCHEDULER_KEY];
  const mod = require(SCHEDULER_KEY);
  delete require.cache[SCHEDULER_KEY];
  if (cached) require.cache[SCHEDULER_KEY] = cached;
  return mod;
}

describe('nothing this card stores reaches double-fire suppression', () => {
  // The scheduler keeps two stores that must never be joined, and `lastRun` is
  // the ONLY input to double-fire suppression. A stored timezone is exactly
  // the kind of value a later change would thread into the next-run
  // calculation, and doing so would put a second input beside lastRun.
  //
  // The clock is wired and the process zone is pinned, so this decides the
  // same way on every machine rather than depending on when it runs.
  test('a routine that declares a timezone is judged due exactly as one that does not', () => {
    const sched = freshScheduler();
    const restore = sched.wireSchedulerDeps({ now: () => new Date('2026-08-24T09:30:00.000Z') });
    try {
      const withZone = normalizeRoutine(
        { name: 'r', schedule: 'every day at 08:00', prompt: 'p', timezone: SET_ZONE },
        { owner: 'penn' });
      const without = normalizeRoutine(
        { name: 'r', schedule: 'every day at 08:00', prompt: 'p' }, { owner: 'penn' });
      assert.strictEqual(withZone.timezone, SET_ZONE, 'the zone did not survive to the comparison');

      // Nothing to suppress: the same slot, whatever the routine declares.
      const dueWith = sched.getNextRun(withZone.schedule, null);
      const dueWithout = sched.getNextRun(without.schedule, null);
      assert.ok(dueWith instanceof Date, 'the routine was not judged due at all');
      assert.strictEqual(dueWith.getTime(), dueWithout.getTime());

      // And suppressed: a run already recorded today holds both back, so the
      // zone reaches neither the decision nor the value it is read against.
      const lastRun = '2026-08-24T08:00:00.000Z';
      assert.strictEqual(sched.getNextRun(withZone.schedule, lastRun), null);
      assert.strictEqual(sched.getNextRun(without.schedule, lastRun), null);

      // The suppression input list itself, pinned: a schedule and the last run,
      // and nothing else.
      assert.strictEqual(sched.getNextRun.length, 2);
    } finally {
      sched.wireSchedulerDeps(restore);
    }
  });
});
