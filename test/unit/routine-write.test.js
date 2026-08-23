'use strict';
// Creating a routine: the block append, and the handler that puts one in an
// agent file.
//
// The data model already had a WRITER, which replaces or appends named keys
// inside a routine block that exists. It had no way to make the block. That is
// the gap this covers, and the risk is the same one the writer was shaped
// around: the frontmatter format is hand rolled, there is no library behind
// it, and the parts most easily lost are the ones nobody thought to preserve.
// So the fixture carries a key outside the routines section, a key inside an
// existing routine, a second routine, a key after the section, and a body.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { appendRoutineBlock, parseRoutineBlocks, normalizeRoutine } = require('../../lib/agents/routines.js');
const { extractFrontmatterText, parseRoutines } = require('../../lib/agents/discovery.js');
const { handleSaveRoutine } = require('../../lib/protocol/handlers/team.js');
const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');
const config = require('../../lib/config.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const WITH_ROUTINES = [
  '---',
  'name: piper',
  'displayName: Piper',
  'aKeyThisCardNeverHeardOf: keep me exactly',
  'routines:',
  '  - name: morning-digest',
  '    schedule: every day at 08:00',
  '    prompt: Run the digest',
  '    aRoutineKeyTheWriterDoesNotKnow: keep me too',
  'trailingKey: still here',
  '---',
  '',
  '# Piper',
  '',
  'Body text nobody told the writer about.',
  '',
].join('\n');

const WITHOUT_ROUTINES = [
  '---',
  'name: doc',
  'displayName: Doc',
  'trailingKey: still here',
  '---',
  '',
  '# Doc',
  '',
].join('\n');

const NEW_ROUTINE = {
  name: 'Compile the ops summary',
  schedule: 'every monday at 07:00',
  skill: 'ops-summary',
  prompt: 'Run the ops-summary skill.',
  runOn: 'local',
};

function routinesIn(content) {
  return parseRoutines(extractFrontmatterText(content), { owner: 'piper' });
}

describe('appending a routine block', () => {
  test('a new routine reads back with every field it was given', () => {
    const next = appendRoutineBlock(WITH_ROUTINES, NEW_ROUTINE);
    const added = routinesIn(next).filter(r => r.name === NEW_ROUTINE.name)[0];
    assert.ok(added, 'the routine is in the file');
    assert.strictEqual(added.schedule, 'every monday at 07:00');
    assert.strictEqual(added.skill, 'ops-summary');
    assert.strictEqual(added.prompt, 'Run the ops-summary skill.');
    assert.strictEqual(added.runOn, 'local');
    assert.strictEqual(added.enabled, true);
  });

  test('everything already in the file survives', () => {
    const next = appendRoutineBlock(WITH_ROUTINES, NEW_ROUTINE);
    for (const line of [
      'aKeyThisCardNeverHeardOf: keep me exactly',
      '  - name: morning-digest',
      '    aRoutineKeyTheWriterDoesNotKnow: keep me too',
      'trailingKey: still here',
      'Body text nobody told the writer about.',
    ]) {
      assert.ok(next.includes(line), `lost: ${line}`);
    }
    const existing = routinesIn(next).filter(r => r.name === 'morning-digest')[0];
    assert.strictEqual(existing.schedule, 'every day at 08:00');
    assert.strictEqual(existing.prompt, 'Run the digest');
  });

  test('the first routine in a file creates the section', () => {
    const next = appendRoutineBlock(WITHOUT_ROUTINES, NEW_ROUTINE);
    const added = routinesIn(next).filter(r => r.name === NEW_ROUTINE.name)[0];
    assert.ok(added, 'a file with no routines section gains one');
    assert.strictEqual(added.schedule, 'every monday at 07:00');
    assert.ok(next.includes('trailingKey: still here'), 'the key after the insert survives');
    assert.ok(next.includes('# Doc'), 'the body survives');
    assert.strictEqual(next.match(/^routines:/gm).length, 1, 'exactly one section');
  });

  test('a second routine of the same name does not overwrite the first', () => {
    let next = appendRoutineBlock(WITH_ROUTINES, NEW_ROUTINE);
    next = appendRoutineBlock(next, { ...NEW_ROUTINE, schedule: 'every friday at 16:00' });
    const both = routinesIn(next).filter(r => r.name === NEW_ROUTINE.name);
    assert.strictEqual(both.length, 2);
    assert.deepStrictEqual(both.map(r => r.schedule), ['every monday at 07:00', 'every friday at 16:00']);
  });

  // A newline in a name would split one key into two and corrupt every routine
  // below it. The writer already refuses this for a VALUE; the name is written
  // by this function, so it needs its own refusal.
  test('a name carrying a line break is refused rather than written', () => {
    assert.throws(
      () => appendRoutineBlock(WITH_ROUTINES, { ...NEW_ROUTINE, name: 'first\n    schedule: every day at 03:00' }),
      /line break/,
    );
  });

  test('a routine with no name is refused', () => {
    assert.throws(() => appendRoutineBlock(WITH_ROUTINES, { ...NEW_ROUTINE, name: '' }), /name/i);
  });

  // The reserved target is refused at the write path too, so a message built
  // by anything other than the editor cannot put an unrunnable routine in a
  // file.
  test('the reserved run target is refused', () => {
    assert.throws(
      () => appendRoutineBlock(WITH_ROUTINES, { ...NEW_ROUTINE, runOn: 'agent-computer' }),
      /runOn/,
    );
  });

  // THIS TEST ASSERTED THE OPPOSITE AND THE OPPOSITE WAS THE DEFECT. Handing
  // back the content it was given makes a file this cannot edit look exactly
  // like one it edited, and the caller then writes unchanged bytes and reports
  // a routine that is not there.
  test('a file with nowhere to put a routine is refused, not returned unchanged', () => {
    assert.throws(() => appendRoutineBlock('# Just a document\n', NEW_ROUTINE), /no frontmatter/);
  });

  // The same match fails on a checkout with Windows line endings, which the
  // migration path in this module already says exist.
  test('a file with Windows line endings is refused by name', () => {
    const crlf = WITH_ROUTINES.replace(/\n/g, '\r\n');
    assert.throws(() => appendRoutineBlock(crlf, NEW_ROUTINE), /Windows line endings/);
  });

  test('a name that is not text is refused rather than written as its characters', () => {
    for (const name of [null, 42, '   ', {}]) {
      assert.throws(() => appendRoutineBlock(WITH_ROUTINES, { ...NEW_ROUTINE, name }), /needs a name/,
        `${JSON.stringify(name)} is not a name`);
    }
  });
});

describe('the save_routine handler', () => {
  // The roster cache is a time-based one shared by every test in this process,
  // so a fresh workspace is not enough on its own: a warm entry from a previous
  // test answers for this one and the handler reports the agent as missing.
  //
  // WORTH KNOWING WHY THIS IS HERE. Without it the two files below produced a
  // routine_error and an untouched file, which is what the test asserted, so
  // it passed green while the code it was written to exercise was never
  // reached. It was the assertion on the MESSAGE that found it.
  function fixture(extraAgents) {
    const dir = makeWorkspace({
      agents: { piper: WITH_ROUTINES, doc: WITHOUT_ROUTINES, ...(extraAgents || {}) },
    });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    invalidateAgentCache();
    // Discovery migrates a routine's representation lazily, on read, and
    // writes the file when it does. Letting that happen HERE means a snapshot
    // taken after this call changes only if the code under test changed it,
    // rather than the assertion having to allow for a write it did not cause.
    discoverAgents();
    const sent = [];
    const ctx = {
      agents: {
        invalidateAgentCache: () => {},
        discoverSkills: () => [],
        flagRosterRefresh: () => {},
      },
      workspace: { isInsideWorkspace: (p) => p.startsWith(dir) },
    };
    const ws = { send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
    return { dir, ctx, ws, sent, restore: () => { config.setWorkspace(original); invalidateAgentCache(); } };
  }

  test('a routine lands in the agent file it names', () => {
    const f = fixture();
    try {
      handleSaveRoutine(f.ctx, f.ws, { type: 'save_routine', agentId: 'piper', routine: NEW_ROUTINE });
      const content = fs.readFileSync(path.join(f.dir, '.claude', 'agents', 'piper.md'), 'utf-8');
      const added = routinesIn(content).filter(r => r.name === NEW_ROUTINE.name)[0];
      assert.ok(added, 'the routine is on disk');
      assert.strictEqual(added.schedule, 'every monday at 07:00');
      assert.ok(f.sent.some(m => m.type === 'routine_saved'), 'the client is told');
      assert.ok(f.sent.some(m => m.type === 'agents'), 'the roster is refreshed so the list can show it');
    } finally { f.restore(); }
  });

  test('an unknown agent is an error, not a write', () => {
    const f = fixture();
    try {
      handleSaveRoutine(f.ctx, f.ws, { type: 'save_routine', agentId: 'nobody', routine: NEW_ROUTINE });
      assert.ok(f.sent.some(m => m.type === 'routine_error'));
      assert.ok(!f.sent.some(m => m.type === 'routine_saved'));
    } finally { f.restore(); }
  });

  test('a routine the data model refuses is an error, not a half written file', () => {
    const f = fixture();
    const file = path.join(f.dir, '.claude', 'agents', 'piper.md');
    const before = fs.readFileSync(file, 'utf-8');
    try {
      handleSaveRoutine(f.ctx, f.ws, {
        type: 'save_routine', agentId: 'piper', routine: { ...NEW_ROUTINE, runOn: 'agent-computer' },
      });
      assert.ok(f.sent.some(m => m.type === 'routine_error'));
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), before, 'the file is untouched');
    } finally { f.restore(); }
  });

  // The two files the append path cannot edit, driven through the handler,
  // which is where the damage was: it wrote the unchanged bytes, logged the
  // add and announced success.
  test('a file the routine cannot be placed in errors and is left byte identical', () => {
    for (const [slug, content, reason] of [
      ['crlf', WITH_ROUTINES.replace(/\n/g, '\r\n'), /Windows line endings/],
      ['nofm', '# Just a document\n', /no frontmatter/],
    ]) {
      const f = fixture({ [slug]: content });
      const file = path.join(f.dir, '.claude', 'agents', `${slug}.md`);
      const before = fs.readFileSync(file, 'utf-8');
      try {
        handleSaveRoutine(f.ctx, f.ws, { type: 'save_routine', agentId: slug, routine: NEW_ROUTINE });
        const errors = f.sent.filter(m => m.type === 'routine_error');
        assert.strictEqual(errors.length, 1, `${slug}: the refusal reaches the client`);
        // THE MESSAGE IS ASSERTED, not just its existence. An agent discovery
        // that failed to see this file would also produce a routine_error and
        // an untouched file, so a test that only counted errors would pass
        // without the append path ever being reached.
        assert.match(errors[0].message, reason, `${slug}: the refusal names why`);
        assert.ok(!f.sent.some(m => m.type === 'routine_saved'), `${slug}: nothing claims it saved`);
        assert.strictEqual(fs.readFileSync(file, 'utf-8'), before, `${slug}: the file is untouched`);
      } finally { f.restore(); }
    }
  });

  test('a routine with no message body is an error', () => {
    const f = fixture();
    try {
      handleSaveRoutine(f.ctx, f.ws, { type: 'save_routine', agentId: 'piper' });
      assert.ok(f.sent.some(m => m.type === 'routine_error'));
    } finally { f.restore(); }
  });
});
