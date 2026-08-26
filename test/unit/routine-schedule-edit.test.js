'use strict';
// Changing when a saved routine runs, without deleting and recreating it.
//
// WHAT THE RISK IS HERE, AND IT IS NOT THE FIELD THAT CHANGES. A routine lives
// in hand rolled frontmatter carrying keys this code has never heard of,
// alongside routines somebody wrote by hand and a body nobody told the writer
// about. The fixture below is built to catch a path that rewrites rather than
// edits: a key outside the section, a key inside the routine being touched, a
// second routine, a key after the section, and a body.
//
// AND THE SECOND RISK, WHICH IS THE ONE A SCHEDULE EDIT ADDS. Every other write
// on this road sets a boolean, so the value could not be wrong, only misplaced.
// A schedule is text, and a schedule the scheduler cannot read parses, saves,
// appears in the list and never once fires. So the writer refuses one, and the
// refusal is asserted at the interface rather than only at the model.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { updateRoutineBlock, isWritableSchedule } = require('../../lib/agents/routines.js');
const { extractFrontmatterText, parseRoutines } = require('../../lib/agents/discovery.js');
const { handleSetRoutineSchedule } = require('../../lib/protocol/handlers/team.js');
const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');
const editorModel = require('../../public/routine-editor-model.js');
const config = require('../../lib/config.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const TWO_ROUTINES = [
  '---',
  'name: piper',
  'displayName: Piper',
  'aKeyThisCardNeverHeardOf: keep me exactly',
  'routines:',
  '  - name: morning-digest',
  '    schedule: every day at 08:00',
  '    prompt: Run the digest',
  '    skill: morning-digest',
  '    runOn: local',
  '    enabled: true',
  '    paused: true',
  '    aRoutineKeyTheWriterDoesNotKnow: keep me too',
  '  - name: ops-summary',
  '    schedule: every day at 07:00',
  '    prompt: Run the ops summary',
  'trailingKey: still here',
  '---',
  '',
  '# Piper',
  '',
  'Body text nobody told the writer about.',
  '',
].join('\n');

// Two routines of one name, which the writer supports on purpose. The schedules
// differ so that acting on the wrong one is visible rather than
// indistinguishable.
const NAMESAKES = [
  '---',
  'name: twin',
  'displayName: Twin',
  'routines:',
  '  - name: ops-summary',
  '    schedule: every day at 07:00',
  '    prompt: The first one',
  '  - name: ops-summary',
  '    schedule: every day at 18:00',
  '    prompt: The second one',
  'trailingKey: still here',
  '---',
  '',
  '# Twin',
  '',
].join('\n');

const routinesIn = (content, owner) =>
  parseRoutines(extractFrontmatterText(content), { owner });

// ===== WHAT MAY BE WRITTEN INTO THE FIELD =====
//
// The rule sits on the writer, which is the road an edit takes AND the road a
// creation takes, so both are held to it by one check rather than by two that
// can drift.
describe('a schedule the writer will accept', () => {
  test('every schedule the editor can build is one the writer accepts', () => {
    for (const frequency of editorModel.FREQUENCIES) {
      for (const time of editorModel.times()) {
        const built = editorModel.buildSchedule({ frequency: frequency.value, time: time.value });
        assert.strictEqual(isWritableSchedule(built), true, `${built} is one the editor offers`);
      }
    }
  });

  // Each of these is a real thing somebody has written in an agent file, and
  // each one reads as a schedule while firing nothing. The grammar the
  // scheduler reads is `every day at HH:MM` or `every <weekday> at HH:MM`, and
  // anything else parses to nothing and waits forever.
  test('a schedule that would never fire is refused', () => {
    for (const stored of [
      'every fortnight at 07:00',
      'every weekday at 18:00',
      'every day at 9:00',
      'every day @ 05:00',
      'every day at 25:00',
      'every day at 07:60',
      '0 5 * * *',
      'daily',
      'run every day at 07:00 please',
      'every day at 07:00 then again at 18:00',
      '',
      '   ',
      null,
      undefined,
      42,
    ]) {
      assert.strictEqual(isWritableSchedule(stored), false,
        `${JSON.stringify(stored)} would never fire and must not be written`);
    }
  });

  // The scheduler folds case before it reads, and a routine written in capitals
  // fires today. Refusing it here would refuse a schedule the product runs.
  test('a schedule written in capitals is accepted, because the scheduler reads it', () => {
    assert.strictEqual(isWritableSchedule('Every Monday at 07:00'), true);
  });

  // WIDER THAN THE EDITOR'S OWN LIST, DELIBERATELY. The editor offers the half
  // hour; the scheduler reads any minute. A routine written by hand for 07:03
  // runs perfectly well, and a writer that refused it would be a second opinion
  // about what a routine may be, held in the wrong place.
  test('a minute the editor never offers is still accepted', () => {
    assert.strictEqual(isWritableSchedule('every day at 07:03'), true);
    assert.strictEqual(editorModel.readSchedule('every day at 07:03'), null,
      'and the editor still cannot show it, which is a fact about the picker');
  });

  test('the writer refuses the value rather than writing it', () => {
    assert.throws(
      () => updateRoutineBlock(TWO_ROUTINES, 'morning-digest', { schedule: 'every fortnight at 07:00' }),
      /schedule/,
    );
  });
});

describe('the handler behind the edit', () => {
  function fixture(extra = {}) {
    const dir = makeWorkspace({ agents: { piper: TWO_ROUTINES, twin: NAMESAKES, ...extra } });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    invalidateAgentCache();
    // Discovery migrates a routine's representation lazily, on read, and writes
    // the file when it does. Letting that happen here means a later snapshot
    // changes only if the code under test changed it.
    discoverAgents();
    const sent = [];
    const calls = [];
    const ctx = {
      agents: {
        invalidateAgentCache: () => { calls.push('invalidate'); invalidateAgentCache(); },
        discoverSkills: () => [],
        flagRosterRefresh: () => {},
      },
      workspace: { isInsideWorkspace: (p) => p.startsWith(dir) },
    };
    const ws = {
      send: (m) => { const parsed = JSON.parse(m); calls.push(parsed.type); sent.push(parsed); },
      readyState: 1,
    };
    const fileFor = (slug) => path.join(dir, '.claude', 'agents', `${slug}.md`);
    return {
      dir, ctx, ws, sent, calls, fileFor,
      read: (slug) => fs.readFileSync(fileFor(slug), 'utf-8'),
      restore: () => { config.setWorkspace(original); invalidateAgentCache(); },
    };
  }

  const message = (over = {}) => ({
    type: 'set_routine_schedule', agentId: 'piper', name: 'morning-digest',
    occurrence: 0, schedule: 'every friday at 16:00', ...over,
  });

  test('the routine now runs when it was asked to', () => {
    const f = fixture();
    try {
      handleSetRoutineSchedule(f.ctx, f.ws, message());
      const changed = routinesIn(f.read('piper'), 'piper').find(r => r.name === 'morning-digest');
      assert.strictEqual(changed.schedule, 'every friday at 16:00');
      assert.deepStrictEqual(f.calls, ['routine_rescheduled', 'invalidate', 'agents']);
      const reply = f.sent[0];
      assert.strictEqual(reply.agentId, 'piper');
      assert.strictEqual(reply.name, 'morning-digest');
      assert.strictEqual(reply.schedule, 'every friday at 16:00');
    } finally { f.restore(); }
  });

  // The block is EDITED, not replaced. A save that appended a second routine of
  // the same name would leave the old schedule firing beside the new one, which
  // is the worst outcome this path has: the reader asked for a change and got an
  // addition.
  test('the routine keeps its place in the file and gains no twin', () => {
    const f = fixture();
    try {
      const before = routinesIn(f.read('piper'), 'piper').map(r => r.name);
      handleSetRoutineSchedule(f.ctx, f.ws, message());
      const after = routinesIn(f.read('piper'), 'piper');
      assert.deepStrictEqual(after.map(r => r.name), before,
        'the same routines in the same order, and no new entry');
      assert.strictEqual((f.read('piper').match(/^routines:/gm) || []).length, 1);
      assert.strictEqual((f.read('piper').match(/- name: morning-digest/g) || []).length, 1);
    } finally { f.restore(); }
  });

  // Everything a schedule edit is NOT. Each of these has its own control and its
  // own message, and a reschedule that moved any of them would be an edit
  // nobody asked for arriving under the one they did.
  test('an edit changes when the routine runs and nothing else about it', () => {
    const f = fixture();
    try {
      const was = routinesIn(f.read('piper'), 'piper').find(r => r.name === 'morning-digest');
      handleSetRoutineSchedule(f.ctx, f.ws, message());
      const now = routinesIn(f.read('piper'), 'piper').find(r => r.name === 'morning-digest');
      for (const field of ['name', 'enabled', 'paused', 'runOn', 'skill', 'prompt', 'owner', 'planHash']) {
        assert.deepStrictEqual(now[field], was[field], `${field} changed under a schedule edit`);
      }
      assert.strictEqual(now.paused, true, 'a paused routine is still paused after it is rescheduled');
      assert.strictEqual(now.enabled, true);
    } finally { f.restore(); }
  });

  test('the sibling routine and the keys the writer never heard of survive', () => {
    const f = fixture();
    try {
      handleSetRoutineSchedule(f.ctx, f.ws, message());
      const content = f.read('piper');
      for (const line of [
        'aKeyThisCardNeverHeardOf: keep me exactly',
        'aRoutineKeyTheWriterDoesNotKnow: keep me too',
        '  - name: ops-summary',
        '    schedule: every day at 07:00',
        'trailingKey: still here',
        'Body text nobody told the writer about.',
      ]) {
        assert.ok(content.includes(line), `lost: ${line}`);
      }
    } finally { f.restore(); }
  });

  // The roster goes back out describing the file as it now is. A warm cache
  // would answer with the old schedule, and the list the reader is returned to
  // would show the routine they just changed still on its old time.
  test('the roster is invalidated before it is rebroadcast, and carries the new schedule', () => {
    const f = fixture();
    try {
      handleSetRoutineSchedule(f.ctx, f.ws, message());
      const broadcast = f.sent.filter(m => m.type === 'agents').pop();
      const piper = broadcast.agents.find(a => a.id === 'piper');
      const carried = piper.routines.find(r => r.name === 'morning-digest');
      assert.strictEqual(carried.schedule, 'every friday at 16:00');
      assert.ok(f.calls.indexOf('invalidate') < f.calls.indexOf('agents'));
    } finally { f.restore(); }
  });

  // A REFUSAL ANSWERS THE SURFACE THAT ASKED, and for this one that surface is
  // the editor rather than the list. The reader is looking at the sentence
  // builder with a save in flight, exactly as they are on the create road, so
  // the refusal travels on the save road that the editor is listening to.
  // routine_action_error would land on a routines list the reader is not
  // looking at.
  test('a schedule the writer refuses answers the editor, in words, and writes nothing', () => {
    const f = fixture();
    try {
      const before = f.read('piper');
      handleSetRoutineSchedule(f.ctx, f.ws, message({ schedule: 'every fortnight at 07:00' }));
      assert.strictEqual(f.read('piper'), before, 'the file was written to anyway');
      assert.strictEqual(f.sent[0].type, 'routine_error');
      assert.match(f.sent[0].message, /fortnight/,
        'the refusal quotes the schedule that was refused rather than saying one was');
      assert.ok(!f.calls.includes('routine_rescheduled'));
    } finally { f.restore(); }
  });

  // THE WORDS MATTER AS WELL AS THE REFUSAL, and this is the assertion that
  // makes the check above the message worth having. Without it the read-back
  // still refuses, because a null value writes nothing and the field then does
  // not hold what was asked for, so the routine is safe either way. What is
  // lost is the reason: the reader is told the routine could not be rescheduled
  // rather than that nothing said when to run it.
  test('a message with no schedule in it is refused, saying which part is missing', () => {
    for (const schedule of [undefined, null, '', '   ', 42, { every: 'day' }]) {
      const f = fixture();
      try {
        const before = f.read('piper');
        handleSetRoutineSchedule(f.ctx, f.ws, message({ schedule }));
        assert.strictEqual(f.read('piper'), before, `${JSON.stringify(schedule)} reached the file`);
        assert.strictEqual(f.sent[0].type, 'routine_error');
        assert.match(f.sent[0].message, /schedule is required/i,
          `${JSON.stringify(schedule)} is nothing, and the refusal should say so`);
      } finally { f.restore(); }
    }
  });

  // The parser trims on the way back out of the file, so a value written with
  // the caller's own spacing would be compared against an unpadded read-back and
  // refused as a write that did not land, having in fact landed correctly.
  test('a schedule arriving with spacing around it lands, and lands trimmed', () => {
    const f = fixture();
    try {
      handleSetRoutineSchedule(f.ctx, f.ws, message({ schedule: '  every friday at 16:00  ' }));
      assert.strictEqual(f.sent[0].type, 'routine_rescheduled');
      assert.strictEqual(f.sent[0].schedule, 'every friday at 16:00');
      const changed = routinesIn(f.read('piper'), 'piper').find(r => r.name === 'morning-digest');
      assert.strictEqual(changed.schedule, 'every friday at 16:00');
    } finally { f.restore(); }
  });

  test('a routine that is not there is refused rather than reported rescheduled', () => {
    const f = fixture();
    try {
      const before = f.read('piper');
      handleSetRoutineSchedule(f.ctx, f.ws, message({ name: 'never-existed' }));
      assert.strictEqual(f.read('piper'), before);
      assert.strictEqual(f.sent[0].type, 'routine_error');
    } finally { f.restore(); }
  });

  test('an agent that is not there is refused', () => {
    const f = fixture();
    try {
      handleSetRoutineSchedule(f.ctx, f.ws, message({ agentId: 'nobody' }));
      assert.strictEqual(f.sent[0].type, 'routine_error');
      assert.match(f.sent[0].message, /nobody/);
    } finally { f.restore(); }
  });

  test('an agent file outside the workspace is refused', () => {
    const f = fixture();
    try {
      f.ctx.workspace.isInsideWorkspace = () => false;
      handleSetRoutineSchedule(f.ctx, f.ws, message());
      assert.strictEqual(f.sent[0].type, 'routine_error');
      const unchanged = routinesIn(f.read('piper'), 'piper').find(r => r.name === 'morning-digest');
      assert.strictEqual(unchanged.schedule, 'every day at 08:00');
    } finally { f.restore(); }
  });

  // A name does not identify a routine, and defaulting a missing occurrence to
  // zero is what makes every forgetful caller act on the first namesake in
  // silence.
  test('rescheduling the second routine of a name leaves the first on its own time', () => {
    const f = fixture();
    try {
      handleSetRoutineSchedule(f.ctx, f.ws, {
        type: 'set_routine_schedule', agentId: 'twin', name: 'ops-summary',
        occurrence: 1, schedule: 'every friday at 16:00',
      });
      assert.deepStrictEqual(
        routinesIn(f.read('twin'), 'twin').map(r => r.schedule),
        ['every day at 07:00', 'every friday at 16:00'],
      );
    } finally { f.restore(); }
  });

  test('a message with no occurrence is refused rather than assumed to mean the first', () => {
    const f = fixture();
    try {
      const before = f.read('twin');
      handleSetRoutineSchedule(f.ctx, f.ws, {
        type: 'set_routine_schedule', agentId: 'twin', name: 'ops-summary', schedule: 'every friday at 16:00',
      });
      assert.strictEqual(f.read('twin'), before);
      assert.strictEqual(f.sent[0].type, 'routine_error');
    } finally { f.restore(); }
  });

  // ===== UNCHANGED BYTES ARE NOT AN ANSWER =====
  //
  // A checkout with Windows line endings, which git on Windows produces
  // routinely. Discovery normalises line endings when it READS one, so the
  // routine is on the roster and every lookup before the write succeeds. The
  // writer reads the file raw, its frontmatter pattern never matches, and it
  // returns the content untouched. Reading that as success announces a routine
  // moved to an afternoon that still fires at eight in the morning.
  const CRLF = TWO_ROUTINES.replace(/\n/g, '\r\n');

  test('a file the writer cannot address is refused rather than reported rescheduled', () => {
    const f = fixture({ crlf: CRLF });
    try {
      const before = f.read('crlf');
      handleSetRoutineSchedule(f.ctx, f.ws, message({ agentId: 'crlf' }));
      assert.strictEqual(f.read('crlf'), before, 'nothing was written, which is correct');
      assert.strictEqual(f.sent[0].type, 'routine_error',
        'nothing was written and the reader was told the routine had moved');
    } finally { f.restore(); }
  });

  // Asking for the time a routine already runs at is a second press, or two
  // windows asking at once. Nothing to write and nothing to complain about,
  // exactly as pausing an already paused routine decides.
  test('rescheduling to the time it already runs says so rather than erroring', () => {
    const f = fixture();
    try {
      handleSetRoutineSchedule(f.ctx, f.ws, message({ schedule: 'every day at 08:00' }));
      assert.strictEqual(f.sent[0].type, 'routine_rescheduled');
      assert.strictEqual(f.sent[0].schedule, 'every day at 08:00');
    } finally { f.restore(); }
  });

  test('the edit is wired into the dispatch', () => {
    const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
    assert.strictEqual(buildDispatch().set_routine_schedule, handleSetRoutineSchedule);
  });
});
