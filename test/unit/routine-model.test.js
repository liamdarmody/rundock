'use strict';
// The routine data model: typed fields, and the write path back into an agent
// file.
//
// The write path is the spine. Routines have always been readable and never
// writable, so "a field round-trips" is a claim about code that did not exist
// rather than about a parser that already accepted anything. The fixture below
// deliberately carries a frontmatter key, a key inside the routine block, a
// second routine, and a body that the writer is never told about, because the
// risk in a hand-rolled frontmatter format with no library behind it is losing
// the parts nobody thought to preserve.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseRoutines, extractFrontmatterText } = require('../../lib/agents/discovery.js');
const { _internal: srv } = require('../../server.js');
const { makeWorkspace, agentFile, cleanup } = require('../helpers/workspace.js');
const {
  updateRoutineBlock, normalizeRoutine, isRunOnSupported, computePlanHash,
} = require('../../lib/agents/routines.js');

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
  '- a list item',
  '',
].join('\n');

// Split on the frontmatter fences by index so a body containing its own fence
// cannot confuse the split.
function splitFile(content) {
  const end = content.indexOf('\n---\n', 4);
  return { frontmatter: content.slice(4, end), body: content.slice(end + 5) };
}

describe('routine write path', () => {
  const written = {
    runOn: 'local',
    skill: 'content-linter',
    owner: 'penn',
    enabled: true,
    paused: false,
    planHash: 'f00dcafe',
    planApprovedAt: '2026-08-21T09:00:00.000Z',
  };

  test('every field survives a write-then-read cycle with its value and its type', () => {
    const updated = updateRoutineBlock(FIXTURE, 'morning-digest', written);
    const routines = parseRoutines(extractFrontmatterText(updated), { owner: 'penn' });
    const r = routines.find(x => x.name === 'morning-digest');

    // Values, field by field, named so a failure says which one moved.
    assert.strictEqual(r.name, 'morning-digest');
    assert.strictEqual(r.schedule, 'every day at 08:00');
    assert.strictEqual(r.prompt, 'Run the digest');
    assert.strictEqual(r.runOn, 'local');
    assert.strictEqual(r.skill, 'content-linter');
    assert.strictEqual(r.owner, 'penn');
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.paused, false);
    assert.strictEqual(r.planHash, 'f00dcafe');
    assert.strictEqual(r.planApprovedAt, '2026-08-21T09:00:00.000Z');

    // Types, because the parser this replaces returned a string for every
    // value, so a boolean asserted only by value would pass on 'true'.
    assert.strictEqual(typeof r.enabled, 'boolean');
    assert.strictEqual(typeof r.paused, 'boolean');
    assert.strictEqual(typeof r.runOn, 'string');
    assert.strictEqual(typeof r.skill, 'string');
    assert.strictEqual(typeof r.owner, 'string');
    assert.strictEqual(typeof r.planHash, 'string');
    assert.strictEqual(typeof r.planApprovedAt, 'string');
  });

  test('writing a routine leaves every other frontmatter key byte for byte', () => {
    const updated = updateRoutineBlock(FIXTURE, 'morning-digest', written);
    const before = splitFile(FIXTURE).frontmatter.split('\n');
    const after = splitFile(updated).frontmatter.split('\n');

    // A writer that does nothing preserves everything, so prove the write
    // happened before claiming it was careful.
    assert.ok(after.includes('    runOn: local'), 'the write never landed');

    // Everything above the edited block.
    const head = before.indexOf('  - name: morning-digest');
    assert.deepStrictEqual(after.slice(0, head), before.slice(0, head));

    // Everything from the next routine onward, which covers the second
    // routine and the top-level key that follows the block.
    const tailBefore = before.slice(before.indexOf('  - name: weekly-review'));
    const tailAfter = after.slice(after.indexOf('  - name: weekly-review'));
    assert.deepStrictEqual(tailAfter, tailBefore);

    // The unknown key inside the edited block itself.
    assert.ok(after.includes('    aRoutineKeyTheWriterDoesNotKnow: keep me too'),
      'an unknown key inside the edited routine was dropped');
  });

  test('writing a routine leaves the file body unchanged', () => {
    const updated = updateRoutineBlock(FIXTURE, 'morning-digest', written);
    assert.strictEqual(splitFile(updated).body, splitFile(FIXTURE).body);
  });
});

describe('routine representation', () => {
  const routine = (fields) => normalizeRoutine({ name: 'r', ...fields });

  test('runOn accepts local, and defaults to it when absent or unrecognised', () => {
    assert.strictEqual(routine({ runOn: 'local' }).runOn, 'local');
    assert.strictEqual(routine({}).runOn, 'local');
    assert.strictEqual(routine({ runOn: 'lcoal' }).runOn, 'local');
  });

  test('agent-computer is recognised and kept, and is not a working value in this release', () => {
    // Kept rather than coerced: an author who wrote it should still find it
    // there. Excluded from the supported set: nothing may treat it as runnable.
    assert.strictEqual(routine({ runOn: 'agent-computer' }).runOn, 'agent-computer');
    assert.strictEqual(isRunOnSupported('agent-computer'), false);
    assert.strictEqual(isRunOnSupported('local'), true);
  });

  test('the skill a routine runs is parsed', () => {
    assert.strictEqual(routine({ skill: 'content-linter' }).skill, 'content-linter');
    assert.strictEqual(routine({}).skill, null);
  });

  test('an explicit owner is parsed and beats the declaring agent', () => {
    assert.strictEqual(normalizeRoutine({ name: 'r', owner: 'lea' }, { owner: 'penn' }).owner, 'lea');
  });

  test('enabled and paused are booleans, not the strings the old parser produced', () => {
    const off = routine({ enabled: 'false', paused: 'true' });
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(off.paused, true);
    assert.strictEqual(typeof off.enabled, 'boolean');
    assert.strictEqual(typeof off.paused, 'boolean');
    // Quoted, because authors quote things.
    assert.strictEqual(routine({ enabled: '"false"' }).enabled, false);
    // Absent, and unreadable, both fall back to the meaning files have today.
    assert.strictEqual(routine({}).enabled, true);
    assert.strictEqual(routine({}).paused, false);
    assert.strictEqual(routine({ enabled: 'maybe' }).enabled, true);
  });

  test('planApprovedAt and the plan hash are parsed', () => {
    const r = routine({ planApprovedAt: '2026-08-21T09:00:00.000Z', planHash: 'deadbeef' });
    assert.strictEqual(r.planApprovedAt, '2026-08-21T09:00:00.000Z');
    assert.strictEqual(r.planHash, 'deadbeef');
    assert.strictEqual(routine({}).planApprovedAt, null);
    assert.strictEqual(routine({}).planHash, null);
  });
});

describe('ownership', () => {
  after(cleanup);

  // Ownership used to be positional and unwritten: a routine belonged to the
  // agent file that declared it, and nothing recorded that anywhere. An
  // explicit owner has to leave those files meaning exactly what they mean
  // today, which is what this asserts through the real discovery path rather
  // than through the parser in isolation.
  test('a routine that declares no owner is owned by the agent whose file declares it', () => {
    const dir = makeWorkspace({
      agents: {
        'content-lead': agentFile({
          name: 'content-lead', displayName: 'Penn', role: 'Content Lead',
          type: 'specialist', order: 2,
          routines: [
            { name: 'morning-digest', schedule: 'every day at 08:00', prompt: 'Run the digest' },
            { name: 'handover', schedule: 'every friday at 16:00', prompt: 'Hand over', owner: 'executive-assistant' },
          ],
        }),
      },
    });
    srv.setWorkspace(dir);
    const penn = srv.discoverAgents().find(a => a.id === 'content-lead');
    assert.strictEqual(penn.routines[0].owner, 'content-lead');
    assert.strictEqual(penn.routines[1].owner, 'executive-assistant');
  });
});

describe('plan hash', () => {
  const plan = (fields) => computePlanHash(normalizeRoutine({
    name: 'morning-digest', prompt: 'Run the digest', skill: 'content-linter', ...fields,
  }, { owner: 'penn' }));

  // The unchanged cases are the ones that matter. A hash that moved when the
  // schedule moved would invalidate an approval every time someone shifted a
  // routine by ten minutes, which makes approval worthless.
  test('changing only the schedule leaves the hash unchanged', () => {
    assert.strictEqual(
      plan({ schedule: 'every day at 08:00' }),
      plan({ schedule: 'every friday at 16:00' }));
  });

  test('changing enabled or paused leaves the hash unchanged', () => {
    const base = plan({});
    assert.strictEqual(plan({ enabled: 'false' }), base);
    assert.strictEqual(plan({ paused: 'true' }), base);
  });

  test('changing what the routine does changes the hash', () => {
    const base = plan({});
    assert.notStrictEqual(plan({ prompt: 'Run something else' }), base);
    assert.notStrictEqual(plan({ skill: 'voice-editor' }), base);
    assert.notStrictEqual(plan({ runOn: 'agent-computer' }), base);
    assert.notStrictEqual(plan({ owner: 'executive-assistant' }), base);
  });

  test('the hash does not depend on the order the fields appear in the file', () => {
    const ordered = [
      'routines:',
      '  - name: morning-digest',
      '    schedule: every day at 08:00',
      '    prompt: Run the digest',
      '    skill: content-linter',
      '    runOn: local',
    ].join('\n');
    const shuffled = [
      'routines:',
      '  - name: morning-digest',
      '    runOn: local',
      '    skill: content-linter',
      '    prompt: Run the digest',
      '    schedule: every day at 08:00',
    ].join('\n');
    const hashOf = (fm) => computePlanHash(parseRoutines(fm, { owner: 'penn' })[0]);
    assert.strictEqual(hashOf(shuffled), hashOf(ordered));
  });

  test('the hash is stable across a write-then-read cycle', () => {
    const source = parseRoutines(extractFrontmatterText(FIXTURE), { owner: 'penn' })
      .find(r => r.name === 'morning-digest');
    const before = computePlanHash(source);
    const updated = updateRoutineBlock(FIXTURE, 'morning-digest', {
      planHash: before, planApprovedAt: '2026-08-21T09:00:00.000Z',
    });
    const readBack = parseRoutines(extractFrontmatterText(updated), { owner: 'penn' })
      .find(r => r.name === 'morning-digest');
    // Both halves: the stored value survives, and recomputing from what came
    // back off disk lands on the same hash.
    assert.strictEqual(readBack.planHash, before);
    assert.strictEqual(computePlanHash(readBack), before);
  });
});

describe('migration of existing routines', () => {
  after(cleanup);

  const AGENT = 'content-lead';
  function legacyWorkspace() {
    const dir = makeWorkspace({
      agents: {
        [AGENT]: agentFile({
          name: AGENT, displayName: 'Penn', role: 'Content Lead',
          type: 'specialist', order: 2,
          routines: [{ name: 'morning-digest', schedule: 'every day at 08:00', prompt: 'Run the digest' }],
          body: 'You are Penn.\n\nA body the migration is not allowed to touch.',
        }),
      },
    });
    srv.setWorkspace(dir);
    return { dir, file: path.join(dir, '.claude', 'agents', `${AGENT}.md`) };
  }

  function reread() {
    srv.invalidateAgentCache();
    return srv.discoverAgents();
  }

  test('an existing routine gains the new representation, detected without a version marker', () => {
    const { file } = legacyWorkspace();
    const original = fs.readFileSync(file, 'utf-8');
    const agents = reread();

    const written = fs.readFileSync(file, 'utf-8');
    assert.ok(written.includes('    runOn: local'), 'runOn not written');
    assert.ok(written.includes('    enabled: true'), 'enabled not written');
    assert.ok(written.includes('    paused: false'), 'paused not written');

    const routine = agents.find(a => a.id === AGENT).routines[0];
    assert.ok(written.includes(`    planHash: ${routine.planHash}`), 'planHash not written');
    assert.strictEqual(routine.planHash, computePlanHash(routine));

    // Nothing stamps a schema version anywhere: the data says whether it has
    // been migrated, the same way the conversation store decides.
    assert.ok(!/version/i.test(written), 'a version marker was written');

    // Ownership stays positional unless it was declared, so a file that never
    // named an owner still means what it meant.
    assert.ok(!written.includes('owner:'), 'an owner was written into a file that declared none');

    // And the parts the migration was never told about survive.
    assert.strictEqual(splitFile(written).body, splitFile(original).body);
    assert.strictEqual(
      splitFile(written).frontmatter.split('\n').slice(0, 5).join('\n'),
      splitFile(original).frontmatter.split('\n').slice(0, 5).join('\n'));
  });

  test('running the migration twice changes nothing on the second run', () => {
    const { file } = legacyWorkspace();
    reread();
    const afterFirst = fs.readFileSync(file, 'utf-8');

    const logs = [];
    const realLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try { reread(); } finally { console.log = realLog; }

    assert.strictEqual(fs.readFileSync(file, 'utf-8'), afterFirst);
    // Identical bytes are not enough on their own: a second pass that rewrites
    // the same content and announces it has still done something. Nothing at
    // all should happen.
    assert.deepStrictEqual(logs.filter(l => l.includes('[migrate]')), []);
  });

  test('a file with Windows line endings is read migrated and left alone on disk', () => {
    const { file } = legacyWorkspace();
    const crlf = fs.readFileSync(file, 'utf-8').replace(/\n/g, '\r\n');
    fs.writeFileSync(file, crlf);

    const routine = reread().find(a => a.id === AGENT).routines[0];
    assert.strictEqual(routine.runOn, 'local');
    assert.strictEqual(routine.enabled, true);
    assert.strictEqual(typeof routine.planHash, 'string');
    // Rewriting every line in the file to record four keys is not a trade a
    // migration gets to make, so the file keeps its line endings and waits.
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), crlf);
  });

  test('the pre-migration backup is written once and never overwritten', () => {
    const { file } = legacyWorkspace();
    const original = fs.readFileSync(file, 'utf-8');
    reread();

    const backup = `${file}.pre-routine-model-backup`;
    assert.ok(fs.existsSync(backup), 'no backup was written');
    assert.strictEqual(fs.readFileSync(backup, 'utf-8'), original);

    // A second routine, declared later and un-migrated, forces another
    // migrating write. The backup must still hold the ORIGINAL file.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(
      '    prompt: Run the digest\n',
      '    prompt: Run the digest\n  - name: handover\n    schedule: every friday at 16:00\n    prompt: Hand over\n'));
    reread();
    assert.ok(fs.readFileSync(file, 'utf-8').includes('  - name: handover'), 'the second routine was lost');
    assert.strictEqual(fs.readFileSync(backup, 'utf-8'), original, 'the backup was overwritten');
  });

  test('a failed migrating write is logged and leaves the read usable', () => {
    const { file } = legacyWorkspace();
    const before = fs.readFileSync(file, 'utf-8');
    fs.chmodSync(file, 0o444);
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      const agents = reread();
      const routine = agents.find(a => a.id === AGENT).routines[0];
      // The read still returns the new representation: it is built in memory
      // and the write is only how it is remembered for next time.
      assert.strictEqual(routine.runOn, 'local');
      assert.strictEqual(routine.enabled, true);
      assert.strictEqual(routine.paused, false);
      assert.strictEqual(typeof routine.planHash, 'string');
    } finally {
      console.error = realError;
      fs.chmodSync(file, 0o644);
    }
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), before, 'the unwritable file changed');
    assert.ok(errors.some(e => /routine/i.test(e)), `nothing was logged, saw: ${JSON.stringify(errors)}`);
  });
});

describe('the writer at its edges', () => {
  test('a key already present is replaced in place, not duplicated', () => {
    const once = updateRoutineBlock(FIXTURE, 'morning-digest', { enabled: false, prompt: 'Run it differently' });
    const twice = updateRoutineBlock(once, 'morning-digest', { enabled: true });
    const lines = splitFile(twice).frontmatter.split('\n');
    const block = lines
      .slice(lines.indexOf('  - name: morning-digest'), lines.indexOf('  - name: weekly-review'))
      .filter(l => /^\s+(enabled|prompt):/.test(l));
    assert.deepStrictEqual(block, ['    prompt: Run it differently', '    enabled: true']);
  });

  test('a block with nothing but a name gets its keys at the indent the marker implies', () => {
    const bare = ['---', 'name: penn', 'routines:', '  - name: solo', '---', '', 'body', ''].join('\n');
    const written = updateRoutineBlock(bare, 'solo', { runOn: 'local' });
    assert.ok(written.includes('  - name: solo\n    runOn: local\n'), written);
  });

  test('a routine named in no block leaves the file alone', () => {
    assert.strictEqual(updateRoutineBlock(FIXTURE, 'not-a-routine', { runOn: 'local' }), FIXTURE);
    assert.strictEqual(updateRoutineBlock('no frontmatter here', 'solo', { runOn: 'local' }), 'no frontmatter here');
    assert.strictEqual(updateRoutineBlock('---\nname: penn\n---\nbody', 'solo', { runOn: 'local' }),
      '---\nname: penn\n---\nbody');
  });

  test('a value carrying a line break is refused rather than written', () => {
    // One key would silently become two and every routine below it would move
    // into the wrong block, so this fails where it can still be seen.
    assert.throws(
      () => updateRoutineBlock(FIXTURE, 'morning-digest', { prompt: 'line one\nline two' }),
      /cannot contain a line break/);
  });
});
