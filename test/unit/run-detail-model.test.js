'use strict';
// What a run's record says, turned into words, with the one distinction this
// screen exists to preserve asserted from both sides.
//
// THE DISTINCTION. A record whose file list is unknown carries `files: null`
// and a named reason. A record of a run that changed nothing carries
// `files: []` and `filesStatus: 'known'`. Those are different facts about the
// world: a routine that changed nothing is working normally, and a routine
// whose changes nobody can read is one where the observation is broken. The
// difference decides whether a user trusts an unattended run or reverts it.
//
// A default of `[]` anywhere on the read path collapses them, silently and
// permanently. So the tests below drive one record of each kind through the
// same function and fail if the two answers agree on anything that matters.
//
// NO RAW STATUS WORD. A record says `running`, `succeeded`, `failed` or
// `interrupted`. Those are this store's own vocabulary, they are not English,
// and one of them is actively misleading: `interrupted` is written only by the
// startup close for a record a dead process left open, and it means the ending
// never ran rather than that the run failed. The enumeration below drives
// every one of them and asserts the token itself never survives into anything
// the screen shows.
//
// THE CLOCK IS CONSTRUCTED, never read from the box. Everything here takes an
// explicit `now`, so this file says the same thing at 23:59 as at noon and the
// same thing in London as in Auckland.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');

const model = require('../../public/run-detail-model.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');

/**
 * Every reason code the WRITERS can actually emit, read out of their source.
 *
 * WHY THIS IS DERIVED RATHER THAN TYPED. The list below used to be nine
 * strings typed by hand from a comment naming three writers, with nothing
 * comparing the two. A writer that gained a tenth code would have degraded
 * silently: the screen would show the catch-all, and the one thing a user has
 * to act on, WHICH observation failed, would be lost with nothing going red.
 *
 * Three shapes, because the writers use three. `unknown('x')` is the
 * transcript reader's helper, `reason: 'x'` is how both files return one
 * inline, and `filesReason: 'x'` is what the scheduler stamps onto a record it
 * opens. A fourth shape would be missed, which is why the count is asserted
 * against a floor below: a scan that silently matches nothing is the failure
 * this file is otherwise built to catch.
 */
function reasonsTheWritersEmit() {
  const found = new Set();
  for (const src of [read('lib', 'runtime', 'session-transcript.js'), read('lib', 'scheduler.js')]) {
    for (const m of src.matchAll(/unknown\('([\w-]+)'\)/g)) found.add(m[1]);
    for (const m of src.matchAll(/\b(?:files)?[Rr]eason(?:: | = )[^,;\n]*?'([\w-]+)'/g)) found.add(m[1]);
  }
  return found;
}

// Every status a record can carry, which is the whole of this store's
// vocabulary, taken from lib/scheduler.js's own statement of it. `interrupted`
// is included deliberately: it is the one a reader is most likely to leak,
// because it is written in exactly one place and by nothing anybody watches.
const STATUSES = ['running', 'succeeded', 'failed', 'interrupted'];

// Every reason a file list can be unknown. Six come from the transcript
// reader, one ('running') from the scheduler itself, and the last two only
// from the progress read. All nine reach this screen through the record.
//
// TYPED HERE AND CHECKED AGAINST THE WRITERS, in "every reason the writers can
// emit has words on this screen" below, so this list cannot drift away from
// what the product actually produces.
const REASONS = ['running', 'no-session', 'no-transcript', 'unreadable',
  'unrecognised', 'unresolved', 'delegated', 'no-record', 'no-activity'];

const NOW = new Date('2026-08-24T09:00:00.000Z');

/** The shape the first live run actually left on disk, 2026-08-24 01:30. */
function livingRecord(over = {}) {
  return {
    id: '874c46c4-4f2d-4653-8802-92cad4b3df0b',
    agent: 'default',
    routine: 'Hello World',
    sessionId: '3872034a-fe64-47c6-98bb-2beb40a3e4f8',
    status: 'succeeded',
    startedAt: '2026-08-24T00:30:32.036Z',
    endedAt: '2026-08-24T00:30:45.199Z',
    durationMs: 13163,
    error: null,
    files: [{
      path: '/w/Hello World/hello-world-2026-08-24.md',
      tool: 'Write',
      change: 'created',
      at: '2026-08-24T00:30:43.206Z',
      source: 'transcript',
    }],
    filesStatus: 'known',
    filesReason: null,
    ...over,
  };
}

/** A run that finished and genuinely changed nothing. */
const CHANGED_NOTHING = livingRecord({ files: [], filesStatus: 'known', filesReason: null });

/** A run whose changes nobody can read, in the shape the writer produces. */
const CHANGES_UNKNOWN = livingRecord({ files: null, filesStatus: 'unknown', filesReason: 'no-transcript' });

/** Every string this view would put in front of a reader, flattened. */
function words(view) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(view);
  return out;
}

describe('unknown and empty are two different answers', () => {
  test('a run that changed nothing and a run whose changes are unknown do not render alike', () => {
    const nothing = model.describeRun(CHANGED_NOTHING, { now: NOW });
    const unknown = model.describeRun(CHANGES_UNKNOWN, { now: NOW });
    assert.notDeepStrictEqual(nothing.files, unknown.files,
      'the two records render identically, which is the collapse this screen exists to prevent');
    assert.strictEqual(nothing.files.known, true);
    assert.strictEqual(unknown.files.known, false);
    // Not merely different objects: the words differ too, because a view model
    // that differs only in a flag nothing renders is the same defect wearing a
    // shape a test cannot see.
    assert.notDeepStrictEqual(words(nothing.files), words(unknown.files));
  });

  test('a run whose changes are unknown never claims it changed nothing', () => {
    const view = model.describeRun(CHANGES_UNKNOWN, { now: NOW });
    assert.strictEqual(view.files.known, false);
    assert.ok(!('entries' in view.files),
      'an unknown list carries no entries at all, so nothing downstream can count them');
    for (const s of words(view)) {
      assert.ok(!/changed no files|changed nothing|no files were changed/i.test(s),
        `a run whose changes are unknown says "${s}", which is the sentence for a run that changed nothing`);
    }
  });

  test('a run that changed nothing says so in its own words', () => {
    const view = model.describeRun(CHANGED_NOTHING, { now: NOW });
    assert.strictEqual(view.files.known, true);
    assert.deepStrictEqual(view.files.entries, []);
    assert.ok(words(view).some(s => /changed no files/i.test(s)),
      'a run that changed nothing has to say it changed nothing, not merely show an empty list');
  });

  test('a null list is never read through a default', () => {
    // The mutation this test exists for is `record.files || []`, which
    // type-checks, reads as tidiness and erases the distinction for good.
    for (const status of ['unknown']) {
      const view = model.describeRun(livingRecord({ files: null, filesStatus: status, filesReason: 'unreadable' }), { now: NOW });
      assert.strictEqual(view.files.known, false);
    }
    // And a record that claims to know while carrying no list is unknown too:
    // the claim and the list disagree, and reading a disagreement as "nothing
    // changed" is the same erasure by a different door.
    const contradictory = model.describeRun(livingRecord({ files: null, filesStatus: 'known', filesReason: null }), { now: NOW });
    assert.strictEqual(contradictory.files.known, false,
      'a record claiming a known list while carrying none was read as a run that changed nothing');
  });

  test('the reason the changes are unknown reaches the reader in plain words', () => {
    const said = new Map();
    for (const reason of REASONS) {
      const view = model.describeRun(livingRecord({ files: null, filesStatus: 'unknown', filesReason: reason }), { now: NOW });
      const words = view.files.reason;
      assert.ok(typeof words === 'string' && words.length > 20,
        `${reason} produced no sentence a reader could act on`);
      assert.ok(!words.includes(reason) || reason === 'running',
        `${reason} leaked its own machine code into the sentence`);
      assert.ok(/[a-z] [a-z]/.test(words) && words.trim().endsWith('.'),
        `${reason} produced "${words}", which is not a sentence`);
      // AND IT IS THIS REASON'S SENTENCE, not the catch-all. A view that fell
      // through to the fallback for every code would satisfy every assertion
      // above while telling nine different users the same useless thing, and
      // the reason is the whole of what a user has to act on: a transcript
      // that is missing and a subagent that kept its own record want
      // different responses.
      assert.notStrictEqual(words, model.FILES_UNKNOWN_FALLBACK,
        `${reason} fell through to the catch-all instead of naming what happened`);
      assert.ok(!said.has(words), `${reason} says the same thing as ${said.get(words)}`);
      said.set(words, reason);
    }
  });

  test('every reason the writers can emit has words on this screen', () => {
    const emitted = reasonsTheWritersEmit();
    // A SCAN THAT MATCHES NOTHING WOULD PASS EVERY ASSERTION BELOW. The floor
    // is what makes this check able to fail if the writers move to a shape
    // these patterns do not read.
    assert.ok(emitted.size >= 9,
      `only ${emitted.size} reason codes were found in the writers, so this check is reading `
      + 'less of them than it did when it was written. Fix the patterns rather than the floor.');
    for (const code of emitted) {
      assert.ok(Object.prototype.hasOwnProperty.call(model.FILES_UNKNOWN_WORDS, code),
        `a writer emits "${code}" and this screen has no words for it, so a user meeting it is `
        + 'told only that the reason is unrecognised, which loses the one fact they can act on');
    }
    // And the other way, so a code that stops being emitted does not sit here
    // forever as words nobody can reach.
    for (const code of Object.keys(model.FILES_UNKNOWN_WORDS)) {
      assert.ok(emitted.has(code),
        `this screen carries words for "${code}" and no writer emits it any more`);
    }
    // The hand-written list the rest of this file drives is the same set.
    assert.deepStrictEqual([...emitted].sort(), [...REASONS].sort());
  });

  test('a reason this version has never seen still reads as plain words', () => {
    for (const odd of ['a-reason-invented-later', null, undefined, '', 42]) {
      const view = model.describeRun(livingRecord({ files: null, filesStatus: 'unknown', filesReason: odd }), { now: NOW });
      assert.strictEqual(view.files.known, false);
      assert.ok(view.files.reason.length > 20, `${String(odd)} produced no sentence`);
      assert.ok(!view.files.reason.includes(String(odd)) || odd === null || odd === undefined || odd === '',
        `${String(odd)} was printed at the reader instead of being described`);
    }
  });
});

describe('no raw status word reaches the reader', () => {
  test('every status a record can carry renders without its own token', () => {
    for (const status of STATUSES) {
      const view = model.describeRun(livingRecord({ status }), { now: NOW });
      for (const said of words(view.state)) {
        assert.ok(!new RegExp(`\\b${status}\\b`, 'i').test(said),
          `a ${status} run shows "${said}", which is the record's own word rather than English`);
      }
      assert.ok(view.state.headline.length > 10, `${status} has no headline`);
      assert.ok(view.state.chip.length > 2, `${status} has no chip`);
    }
  });

  test('a status this version has never seen is described rather than printed', () => {
    for (const odd of ['cancelled', 'queued', null, undefined, 42]) {
      const view = model.describeRun(livingRecord({ status: odd }), { now: NOW });
      for (const said of words(view.state)) {
        assert.ok(!said.includes(String(odd)),
          `an unrecognised status was printed at the reader as "${said}"`);
      }
      assert.ok(view.state.headline.length > 10, `${String(odd)} has no headline`);
    }
  });

  test('ran is never conflated with succeeded', () => {
    const ok = model.describeRun(livingRecord({ status: 'succeeded' }), { now: NOW });
    const bad = model.describeRun(livingRecord({ status: 'failed', error: 'Permission denied' }), { now: NOW });
    // Both ran. Only one of them did what it was asked to, and the copy for
    // the one that did not must not be readable as the copy for the one that
    // did: this is the conflation the card names.
    assert.notStrictEqual(ok.state.headline, bad.state.headline);
    assert.notStrictEqual(ok.state.chip, bad.state.chip);
    assert.notStrictEqual(ok.state.tone, bad.state.tone);
    assert.ok(!/^\s*ran\b/i.test(ok.state.headline),
      'the succeeded headline leads with "ran", which says only that it happened');
    // THE CONFLATION IN ITS EXACT FORM. Every one of the four states ran, so a
    // headline whose whole content is that the run happened says nothing that
    // separates the one that got through from the three that did not. The
    // succeeded copy has to claim BOTH halves: that it reached the end, and
    // that it did the thing.
    const cut = model.describeRun(livingRecord({ status: 'interrupted' }), { now: NOW });
    for (const other of [bad.state.headline, cut.state.headline]) {
      assert.ok(!ok.state.headline.split(/[.,]/)[0].trim().toLowerCase()
        .startsWith(other.split(/[.,]/)[0].trim().toLowerCase()),
        'the succeeded headline opens with a claim another state can make too');
    }
    assert.match(ok.state.headline, /got to the end/i,
      'the succeeded headline does not say the run reached its ending, so it is true of a run that did not');
    assert.match(ok.state.headline, /did what it was asked to/i,
      'the succeeded headline does not say the run did the work, so it says only that it happened');
  });

  test('a run cut short by a restart says the ending never ran, in words the failed run does not use', () => {
    const cut = model.describeRun(livingRecord({ status: 'interrupted', endedAt: null, durationMs: null }), { now: NOW });
    const failed = model.describeRun(livingRecord({ status: 'failed', error: 'Permission denied' }), { now: NOW });
    assert.notStrictEqual(cut.state.chip, failed.state.chip);
    assert.notStrictEqual(cut.state.headline, failed.state.headline);
    assert.notStrictEqual(cut.state.tone, failed.state.tone,
      'the interrupted run borrows the failure tone, so a reader cannot tell the two apart at a glance');
    // The fact that has to reach the reader: the ending never ran, so nothing
    // recorded whether the work got done.
    assert.ok(/never (reached|finished|got to) its ending|never finished|ending never ran/i.test(cut.state.headline + ' ' + cut.state.guidance),
      'nothing in the interrupted copy says the ending never ran');
    // And it must not read as a failure, which is the specific wrong reading.
    assert.ok(!/went wrong|failed|error/i.test(cut.state.headline + ' ' + cut.state.chip),
      'the interrupted copy reads as a failure, which is a claim nobody witnessed');
  });

  test('a failed run carries the reason it gave, in plain words around it', () => {
    const withReason = model.describeRun(livingRecord({ status: 'failed', error: 'Permission denied' }), { now: NOW });
    assert.ok(withReason.state.guidance.includes('Permission denied'));
    // An exit code is not a message, and three of the four failure endings
    // carry no reason at all. That has to read as a fact rather than a gap.
    const noReason = model.describeRun(livingRecord({ status: 'failed', error: null }), { now: NOW });
    assert.ok(noReason.state.guidance.length > 20 && !/null|undefined/.test(noReason.state.guidance));
  });
});

describe('what the run did', () => {
  test('a file created is told apart from a file edited', () => {
    const view = model.describeRun(livingRecord({
      files: [
        { path: '/w/a.md', tool: 'Write', change: 'created', at: '2026-08-24T00:30:43.206Z', source: 'transcript' },
        { path: '/w/b.md', tool: 'Edit', change: 'edited', at: '2026-08-24T00:30:44.206Z', source: 'transcript' },
      ],
      filesStatus: 'known',
      filesReason: null,
    }), { now: NOW });
    const [created, edited] = view.files.entries;
    assert.notStrictEqual(created.changeLabel, edited.changeLabel,
      'a created file and an edited file carry the same label, so the list cannot say which happened');
    assert.match(created.changeLabel, /creat/i);
    assert.match(edited.changeLabel, /edit/i);
    // A change word the reader has never been shown is described rather than
    // printed, for the same reason an unknown status is.
    const odd = model.describeRun(livingRecord({
      files: [{ path: '/w/c.md', tool: 'X', change: 'renamed', at: null, source: 'transcript' }],
      filesStatus: 'known', filesReason: null,
    }), { now: NOW });
    assert.ok(!odd.files.entries[0].changeLabel.includes('renamed'));
  });

  test('a file is named by the part a reader recognises, not by its whole path', () => {
    const view = model.describeRun(livingRecord(), { now: NOW });
    assert.strictEqual(view.files.entries[0].name, 'hello-world-2026-08-24.md');
    assert.strictEqual(view.files.entries[0].path, '/w/Hello World/hello-world-2026-08-24.md');
  });

  test('the files label says whether the run got to the end', () => {
    const ok = model.describeRun(livingRecord(), { now: NOW });
    const bad = model.describeRun(livingRecord({ status: 'failed', error: 'x' }), { now: NOW });
    assert.notStrictEqual(ok.files.label, bad.files.label,
      'a run that stopped partway labels its file list exactly as a run that finished');
  });

  test('a run still going does not report a duration it does not have', () => {
    const live = model.describeRun(livingRecord({ status: 'running', endedAt: null, durationMs: null }), { now: NOW });
    assert.strictEqual(live.duration, null);
    const cut = model.describeRun(livingRecord({ status: 'interrupted', endedAt: null, durationMs: null }), { now: NOW });
    assert.strictEqual(cut.duration, null);
    const done = model.describeRun(livingRecord(), { now: NOW });
    assert.strictEqual(done.duration, '13 seconds');
  });

  test('how long a run took is said at the scale a reader thinks in', () => {
    // An agent run is minutes more often than seconds, and reporting 2,700
    // seconds is a number nobody reads. Every branch is driven, including the
    // one that has no duration at all: a record with none says nothing rather
    // than saying zero, which would report a run that never ended as instant.
    assert.strictEqual(model.durationWords(400), 'under a second');
    assert.strictEqual(model.durationWords(1000), '1 second');
    assert.strictEqual(model.durationWords(13163), '13 seconds');
    assert.strictEqual(model.durationWords(60000), '1 minute');
    assert.strictEqual(model.durationWords(2700000), '45 minutes');
    assert.strictEqual(model.durationWords(7200000), '2 hours');
    for (const nothing of [null, undefined, NaN, Infinity, -1, '13163']) {
      assert.strictEqual(model.durationWords(nothing), null, `${String(nothing)} was read as a duration`);
    }
  });

  test('the record on screen is the record on disk', () => {
    const view = model.describeRun(livingRecord(), { now: NOW });
    assert.strictEqual(view.routine, 'Hello World');
    assert.strictEqual(view.agent, 'default');
    assert.strictEqual(view.id, '874c46c4-4f2d-4653-8802-92cad4b3df0b');
  });

  test('no record at all is a state of its own, not an empty run', () => {
    for (const nothing of [null, undefined, {}, 'not a record']) {
      const view = model.describeRun(nothing, { now: NOW });
      assert.strictEqual(view.found, false, `${String(nothing)} was read as a run`);
      assert.ok(view.state.headline.length > 10);
      // Critically: no record is not a run that changed nothing either.
      assert.strictEqual(view.files.known, false);
      // And it says WHICH absence this is. The catch-all tells a reader the
      // record gives a reason this version cannot read, when the truth is
      // that there is no record to give one.
      assert.strictEqual(view.files.reason, model.FILES_UNKNOWN_WORDS['no-record'],
        `${String(nothing)} blamed an unreadable reason code instead of saying there is no record`);
    }
    assert.strictEqual(model.describeRun(livingRecord(), { now: NOW }).found, true);
  });
});
